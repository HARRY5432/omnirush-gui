//go:build linux

package oci

import (
	"archive/tar"
	"bufio"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
)

// ApplyOptions tune unpacking.
type ApplyOptions struct {
	// Chown sets owners from the tar (only possible as root: the WSL
	// distro). Unprivileged, every file is the user's, which the box's user
	// namespace shows as root.
	Chown bool
}

// ApplyStats counts what one layer did.
type ApplyStats struct {
	Entries   int
	Whiteouts int
	Skipped   int // devices and the like (cannot be made unprivileged)
	Bytes     int64
}

type dirMeta struct {
	path  string
	mode  os.FileMode
	mtime time.Time
}

// Decompress wraps a layer stream: gzip by magic bytes, else plain tar.
func Decompress(r io.Reader) (io.Reader, func() error, error) {
	br := bufio.NewReaderSize(r, 64<<10)
	head, err := br.Peek(2)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, nil, err
	}
	if len(head) == 2 && head[0] == 0x1f && head[1] == 0x8b {
		zr, err := gzip.NewReader(br)
		if err != nil {
			return nil, nil, err
		}
		zr.Multistream(true)
		return zr, zr.Close, nil
	}
	if len(head) >= 2 && head[0] == 0x28 && head[1] == 0xb5 {
		return nil, nil, errors.New("zstd image layers are not supported yet")
	}
	return br, func() error { return nil }, nil
}

// safeJoin resolves name under root without leaving it (no "..", and no
// symlink in a parent pointing outside: parents are resolved inside root).
func safeJoin(root, name string) (string, error) {
	clean := path.Clean("/" + strings.TrimPrefix(name, "./"))
	if clean == "/" {
		return root, nil
	}
	parts := strings.Split(strings.TrimPrefix(clean, "/"), "/")
	cur := root
	for i, part := range parts {
		if part == "" || part == "." || part == ".." {
			return "", fmt.Errorf("bad path %q", name)
		}
		next := filepath.Join(cur, part)
		if i == len(parts)-1 {
			return next, nil
		}
		// Parents: follow symlinks, but resolved inside root.
		for hops := 0; hops < 40; hops++ {
			fi, err := os.Lstat(next)
			if err != nil || fi.Mode()&os.ModeSymlink == 0 {
				break
			}
			target, err := os.Readlink(next)
			if err != nil {
				break
			}
			var resolved string
			if strings.HasPrefix(target, "/") {
				resolved = path.Clean(target)
			} else {
				rel, _ := filepath.Rel(root, filepath.Dir(next))
				resolved = path.Clean("/" + filepath.ToSlash(rel) + "/" + target)
			}
			next = filepath.Join(root, filepath.FromSlash(resolved))
		}
		cur = next
	}
	return cur, nil
}

func removeAllForce(p string) error {
	_ = filepath.Walk(p, func(q string, fi os.FileInfo, err error) error {
		if err == nil && fi.IsDir() && fi.Mode().Perm()&0o700 != 0o700 {
			_ = os.Chmod(q, fi.Mode().Perm()|0o700)
		}
		return nil
	})
	return os.RemoveAll(p)
}

// Unpacker applies layers in order onto one root; folder modes and times
// are set by Finish, after the last layer (a 0555 folder of one layer must
// still take the files of the next).
type Unpacker struct {
	Root string
	Opt  ApplyOptions
	dirs map[string]dirMeta
}

// Apply unpacks one layer (a tar stream, gzip or plain) with the OCI
// whiteout rules: `.wh.<name>` removes name, `.wh..wh..opq` empties the
// folder of what lower layers put there.
func (u *Unpacker) Apply(layer io.Reader) (ApplyStats, error) {
	root, opt := u.Root, u.Opt
	if u.dirs == nil {
		u.dirs = map[string]dirMeta{}
	}
	var st ApplyStats
	r, closeFn, err := Decompress(layer)
	if err != nil {
		return st, err
	}
	tr := tar.NewReader(r)
	// Folders this layer made opaque: their lower contents are dropped once
	// (entries of this layer under them stay).
	opaqueDone := map[string]bool{}
	thisLayer := map[string]bool{}
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return st, err
		}
		st.Entries++
		name := path.Clean("/" + strings.TrimPrefix(hdr.Name, "./"))
		base := path.Base(name)
		dir := path.Dir(name)
		if strings.HasPrefix(base, ".wh.") {
			st.Whiteouts++
			parent, err := safeJoin(root, dir)
			if err != nil {
				return st, err
			}
			if base == ".wh..wh..opq" {
				if !opaqueDone[dir] {
					opaqueDone[dir] = true
					entries, _ := os.ReadDir(parent)
					for _, e := range entries {
						if !thisLayer[path.Join(dir, e.Name())] {
							_ = removeAllForce(filepath.Join(parent, e.Name()))
						}
					}
				}
				continue
			}
			_ = removeAllForce(filepath.Join(parent, strings.TrimPrefix(base, ".wh.")))
			continue
		}
		if name == "/" {
			continue
		}
		target, err := safeJoin(root, name)
		if err != nil {
			return st, err
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return st, err
		}
		thisLayer[name] = true
		existing, lerr := os.Lstat(target)
		if lerr == nil {
			// A folder stays a folder (only its metadata changes); anything else is replaced.
			if !(existing.IsDir() && hdr.Typeflag == tar.TypeDir) {
				if err := removeAllForce(target); err != nil {
					return st, err
				}
			}
		}
		mode := os.FileMode(hdr.Mode & 0o777)
		special := os.FileMode(0)
		if hdr.Mode&0o4000 != 0 {
			special |= os.ModeSetuid
		}
		if hdr.Mode&0o2000 != 0 {
			special |= os.ModeSetgid
		}
		if hdr.Mode&0o1000 != 0 {
			special |= os.ModeSticky
		}
		switch hdr.Typeflag {
		case tar.TypeDir:
			if lerr != nil || !existing.IsDir() {
				if err := os.Mkdir(target, 0o755); err != nil && !os.IsExist(err) {
					return st, err
				}
			}
			u.dirs[target] = dirMeta{target, mode | special, hdr.ModTime}
		case tar.TypeReg, tar.TypeRegA:
			f, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
			if err != nil {
				return st, err
			}
			n, err := io.Copy(f, tr)
			st.Bytes += n
			if cerr := f.Close(); err == nil {
				err = cerr
			}
			if err != nil {
				return st, err
			}
			if err := os.Chmod(target, mode|special); err != nil {
				return st, err
			}
		case tar.TypeSymlink:
			if err := os.Symlink(hdr.Linkname, target); err != nil {
				return st, err
			}
		case tar.TypeLink:
			src, err := safeJoin(root, hdr.Linkname)
			if err != nil {
				return st, err
			}
			if err := os.Link(src, target); err != nil {
				return st, fmt.Errorf("hard link %s: %w", hdr.Name, err)
			}
		case tar.TypeFifo:
			if err := syscall.Mkfifo(target, uint32(mode)); err != nil {
				return st, err
			}
		case tar.TypeChar, tar.TypeBlock:
			if opt.Chown {
				devType := uint32(syscall.S_IFCHR)
				if hdr.Typeflag == tar.TypeBlock {
					devType = syscall.S_IFBLK
				}
				dev := (hdr.Devmajor << 8) | (hdr.Devminor & 0xff) | ((hdr.Devminor &^ 0xff) << 12)
				if err := syscall.Mknod(target, devType|uint32(mode), int(dev)); err == nil {
					break
				}
			}
			st.Skipped++
			delete(thisLayer, name)
			continue
		default:
			st.Skipped++
			delete(thisLayer, name)
			continue
		}
		if opt.Chown {
			_ = os.Lchown(target, hdr.Uid, hdr.Gid)
			if hdr.Typeflag == tar.TypeReg || hdr.Typeflag == tar.TypeRegA {
				// chown drops setuid bits: put them back.
				_ = os.Chmod(target, mode|special)
			}
		}
		if hdr.Typeflag != tar.TypeSymlink && hdr.Typeflag != tar.TypeDir && hdr.Typeflag != tar.TypeLink {
			_ = os.Chtimes(target, hdr.ModTime, hdr.ModTime)
		}
	}
	return st, closeFn()
}

// Finish sets folder modes and times, deepest first.
func (u *Unpacker) Finish() {
	dirs := make([]dirMeta, 0, len(u.dirs))
	for _, d := range u.dirs {
		dirs = append(dirs, d)
	}
	sort.Slice(dirs, func(i, j int) bool { return len(dirs[i].path) > len(dirs[j].path) })
	for _, d := range dirs {
		if fi, err := os.Lstat(d.path); err != nil || !fi.IsDir() {
			continue
		}
		_ = os.Chmod(d.path, d.mode)
		_ = os.Chtimes(d.path, d.mtime, d.mtime)
	}
}
