//go:build linux

package main

// Paths inside the box's root before the root switch. init runs as root
// (real root under unshare in the WSL distro / Lima VM), and the overlay's
// upper layer is the box's from earlier runs: any folder on the way to a
// path init makes, changes or mounts on may be a link the box left there.
// So nothing here goes by path: every path is walked a component at a time
// from the root's own descriptor, never following a link by the kernel. A
// link on the way is read and followed inside the root, as the box will
// see it after the root switch (an absolute target starts again at the
// root, ".." stops there), so it never leads out of it. The kernel's own
// openat2(RESOLVE_IN_ROOT) re-checks every result where it exists (5.6+).
// The mounts init puts in the root (/proc, /dev, /sys) are never walked
// into unless asked for, and a link where init makes a folder or a file of
// its own is removed (it is in the root: the overlay keeps a whiteout) and
// the real one made instead. Mounts go through /proc/self/fd/N, the very
// folder or file the walk opened.

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

const (
	maxLinks = 40

	sysOpenat2          = 437 // the same number on every Linux architecture
	resolveNoSymlinks   = 0x04
	resolveNoMagiclinks = 0x02
	resolveInRoot       = 0x10
)

// forceNoOpenat2: tests of the walk alone.
var forceNoOpenat2 bool

type rootFS struct {
	path    string
	fd      int
	special map[string]bool // first components walks stay out of (init's /proc, /dev, /sys mounts)
	// noOpenat2: the kernel has no openat2 (or it is filtered): the walk alone.
	noOpenat2 bool
	// procFD: mount through /proc/self/fd (false: by the walked path, no links in it).
	procFD bool
}

func openRoot(path string) (*rootFS, error) {
	fd, err := syscall.Open(path, oPath|syscall.O_DIRECTORY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, fmt.Errorf("box root %s: %w", path, err)
	}
	r := &rootFS{path: path, fd: fd, special: map[string]bool{}, noOpenat2: forceNoOpenat2}
	if fi, err := os.Stat("/proc/self/fd"); err == nil && fi.IsDir() {
		r.procFD = true
	}
	return r, nil
}

func (r *rootFS) Close() { _ = syscall.Close(r.fd) }

// pathError: a path init uses goes where it must not (init's own mounts, a file on the way).
type pathError struct {
	rel string
	why string
}

func (e *pathError) Error() string { return fmt.Sprintf("box root: /%s: %s", e.rel, e.why) }

func splitPath(p string) []string {
	var out []string
	for _, c := range strings.Split(p, "/") {
		if c != "" && c != "." {
			out = append(out, c)
		}
	}
	return out
}

func readlinkFD(fd int) (string, error) {
	empty := []byte{0}
	for size := 256; size <= 1<<16; size *= 4 {
		buf := make([]byte, size)
		n, _, e := syscall.Syscall6(syscall.SYS_READLINKAT, uintptr(fd), uintptr(unsafe.Pointer(&empty[0])), uintptr(unsafe.Pointer(&buf[0])), uintptr(size), 0, 0)
		if e != 0 {
			return "", e
		}
		if int(n) < size {
			return string(buf[:n]), nil
		}
	}
	return "", syscall.ENAMETOOLONG
}

type openHow struct {
	Flags   uint64
	Mode    uint64
	Resolve uint64
}

func openat2(dirfd int, path string, flags int, resolve uint64) (int, error) {
	p, err := syscall.BytePtrFromString(path)
	if err != nil {
		return -1, err
	}
	how := openHow{Flags: uint64(flags), Resolve: resolve}
	fd, _, e := syscall.Syscall6(sysOpenat2, uintptr(dirfd), uintptr(unsafe.Pointer(p)), uintptr(unsafe.Pointer(&how)), unsafe.Sizeof(how), 0, 0)
	if e != 0 {
		return -1, e
	}
	return int(fd), nil
}

func sameFile(a, b int) bool {
	var sa, sb syscall.Stat_t
	if syscall.Fstat(a, &sa) != nil || syscall.Fstat(b, &sb) != nil {
		return false
	}
	return sa.Dev == sb.Dev && sa.Ino == sb.Ino
}

// walk opens rel in the root (O_PATH), following links inside it, and returns the descriptor
// and the path it really is at (no link in it). mkdirs: missing folders are made on the way
// (the last one too). allow: a first component of r.special this walk may go into.
func (r *rootFS) walk(rel string, mkdirs bool, allow string) (int, []string, error) {
	todo := splitPath(rel)
	var fds []int
	var names []string
	cur := func() int {
		if len(fds) == 0 {
			return r.fd
		}
		return fds[len(fds)-1]
	}
	closeAll := func() {
		for _, fd := range fds {
			_ = syscall.Close(fd)
		}
		fds, names = nil, nil
	}
	links := 0
	for len(todo) > 0 {
		c := todo[0]
		todo = todo[1:]
		if c == ".." {
			if len(fds) > 0 {
				_ = syscall.Close(fds[len(fds)-1])
				fds, names = fds[:len(fds)-1], names[:len(names)-1]
			}
			continue
		}
		if len(names) == 0 && r.special[c] && c != allow {
			closeAll()
			return -1, nil, &pathError{rel, "goes into /" + c}
		}
		fd, err := syscall.Openat(cur(), c, oPath|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		if err == syscall.ENOENT && mkdirs {
			if err = syscall.Mkdirat(cur(), c, 0o755); err == nil || err == syscall.EEXIST {
				fd, err = syscall.Openat(cur(), c, oPath|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
			}
		}
		if err != nil {
			closeAll()
			return -1, nil, &os.PathError{Op: "open", Path: "/" + strings.Join(append(names, c), "/") + " (in the box)", Err: err}
		}
		var st syscall.Stat_t
		if err := syscall.Fstat(fd, &st); err != nil {
			_ = syscall.Close(fd)
			closeAll()
			return -1, nil, err
		}
		switch st.Mode & syscall.S_IFMT {
		case syscall.S_IFLNK:
			links++
			target, err := readlinkFD(fd)
			_ = syscall.Close(fd)
			if err == nil && links > maxLinks {
				err = syscall.ELOOP
			}
			if err == nil && target == "" {
				err = syscall.ENOENT
			}
			if err != nil {
				closeAll()
				return -1, nil, &os.PathError{Op: "link", Path: "/" + strings.Join(append(names, c), "/") + " (in the box)", Err: err}
			}
			if strings.HasPrefix(target, "/") {
				closeAll()
			}
			todo = append(splitPath(target), todo...)
			continue
		case syscall.S_IFDIR:
		default:
			if len(todo) > 0 {
				_ = syscall.Close(fd)
				closeAll()
				return -1, nil, &pathError{rel, "/" + strings.Join(append(names, c), "/") + " is not a folder"}
			}
		}
		fds, names = append(fds, fd), append(names, c)
	}
	var fd int
	if len(fds) == 0 {
		d, err := syscall.Dup(r.fd)
		if err != nil {
			return -1, nil, err
		}
		syscall.CloseOnExec(d)
		fd = d
	} else {
		fd = fds[len(fds)-1]
		for _, f := range fds[:len(fds)-1] {
			_ = syscall.Close(f)
		}
	}
	if err := r.check(fd, names); err != nil {
		_ = syscall.Close(fd)
		return -1, nil, err
	}
	return fd, names, nil
}

// check: the kernel opens the walked path in the root, with no link allowed, and it must be
// the same file (openat2, 5.6+; where it is missing or filtered the walk alone counts).
func (r *rootFS) check(fd int, names []string) error {
	if r.noOpenat2 {
		return nil
	}
	p := strings.Join(names, "/")
	if p == "" {
		p = "."
	}
	fd2, err := openat2(r.fd, p, oPath|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, resolveInRoot|resolveNoMagiclinks|resolveNoSymlinks)
	for i := 0; err == syscall.EAGAIN && i < 8; i++ {
		fd2, err = openat2(r.fd, p, oPath|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, resolveInRoot|resolveNoMagiclinks|resolveNoSymlinks)
	}
	if err == syscall.ENOSYS || err == syscall.EPERM || err == syscall.EINVAL || err == syscall.E2BIG {
		r.noOpenat2 = true
		return nil
	}
	if err != nil {
		return &pathError{p, "changed while it was opened: " + err.Error()}
	}
	defer syscall.Close(fd2)
	if !sameFile(fd, fd2) {
		return &pathError{p, "changed while it was opened"}
	}
	return nil
}

// parent: the folder rel is in (made when missing) and rel's last name.
func (r *rootFS) parent(rel string, allow string) (int, []string, string, error) {
	parts := splitPath(rel)
	if len(parts) == 0 || parts[len(parts)-1] == ".." {
		return -1, nil, "", &pathError{rel, "not a name"}
	}
	dir := strings.Join(parts[:len(parts)-1], "/")
	fd, names, err := r.walk(dir, true, allow)
	if err != nil {
		return -1, nil, "", err
	}
	name := parts[len(parts)-1]
	if len(names) == 0 && r.special[name] && name != allow {
		_ = syscall.Close(fd)
		return -1, nil, "", &pathError{rel, "goes into /" + name}
	}
	return fd, names, name, nil
}

// open: rel in the root, an existing one (links followed inside the root).
func (r *rootFS) open(rel string, allow string) (int, []string, error) {
	return r.walk(rel, false, allow)
}

// ensure makes rel a folder (dir) or a file in the root: a link there is removed first.
// Returns its descriptor (O_PATH) and where it is.
func (r *rootFS) ensure(rel string, dir bool, allow string) (int, []string, error) {
	pfd, names, name, err := r.parent(rel, allow)
	if err != nil {
		return -1, nil, err
	}
	defer syscall.Close(pfd)
	where := append(append([]string{}, names...), name)
	mode, err := statAt(pfd, name)
	if err == nil && mode == syscall.S_IFLNK {
		// The box's link (it is in the root: the parent was walked there): the real one goes in its place.
		if err := syscall.Unlinkat(pfd, name); err != nil {
			return -1, nil, &pathError{strings.Join(where, "/"), "a link that could not be removed: " + err.Error()}
		}
		err = syscall.ENOENT
	}
	switch {
	case err == syscall.ENOENT && dir:
		if err := syscall.Mkdirat(pfd, name, 0o755); err != nil && err != syscall.EEXIST {
			return -1, nil, &os.PathError{Op: "mkdir", Path: "/" + strings.Join(where, "/") + " (in the box)", Err: err}
		}
	case err == syscall.ENOENT:
		f, err := syscall.Openat(pfd, name, syscall.O_CREAT|syscall.O_EXCL|syscall.O_WRONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0o644)
		if err != nil {
			return -1, nil, &os.PathError{Op: "create", Path: "/" + strings.Join(where, "/") + " (in the box)", Err: err}
		}
		_ = syscall.Close(f)
	case err != nil:
		return -1, nil, err
	case dir && mode != syscall.S_IFDIR:
		return -1, nil, &pathError{strings.Join(where, "/"), "is not a folder"}
	case !dir && mode != syscall.S_IFREG:
		return -1, nil, &pathError{strings.Join(where, "/"), "is not a file"}
	}
	fd, err := syscall.Openat(pfd, name, oPath|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return -1, nil, err
	}
	var st syscall.Stat_t
	if err := syscall.Fstat(fd, &st); err != nil || (dir && st.Mode&syscall.S_IFMT != syscall.S_IFDIR) || (!dir && st.Mode&syscall.S_IFMT != syscall.S_IFREG) {
		_ = syscall.Close(fd)
		return -1, nil, &pathError{strings.Join(where, "/"), "changed while it was made"}
	}
	if err := r.check(fd, where); err != nil {
		_ = syscall.Close(fd)
		return -1, nil, err
	}
	return fd, where, nil
}

// target: the path a mount call uses for fd: the descriptor itself, or (no /proc) the walked
// path, which has no link in it.
func (r *rootFS) target(fd int, names []string) string {
	if r.procFD {
		return fmt.Sprintf("/proc/self/fd/%d", fd)
	}
	return filepath.Join(append([]string{r.path}, names...)...)
}

// ensureDirIn / ensureFileIn: a folder or file of init's own at rel (see ensure).
func (r *rootFS) ensureDirIn(rel string) error {
	fd, _, err := r.ensure(rel, true, "")
	if err == nil {
		_ = syscall.Close(fd)
	}
	return err
}

func (r *rootFS) ensureFileIn(rel string) error {
	fd, _, err := r.ensure(rel, false, "")
	if err == nil {
		_ = syscall.Close(fd)
	}
	return err
}

// chmodIn: the mode of init's own folder or file at rel (a link there is not followed).
func (r *rootFS) chmodIn(rel string, mode uint32) error {
	pfd, _, name, err := r.parent(rel, "")
	if err != nil {
		return err
	}
	defer syscall.Close(pfd)
	fd, err := syscall.Openat(pfd, name, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC|syscall.O_NONBLOCK, 0)
	if err != nil {
		return err
	}
	defer syscall.Close(fd)
	return syscall.Fchmod(fd, mode)
}

// mountIn mounts on the folder or file at rel, made (dir/file) as init's own (see ensure).
func (r *rootFS) mountIn(rel string, dir bool, allow string, mount func(target string) error) error {
	fd, names, err := r.ensure(rel, dir, allow)
	if err != nil {
		return err
	}
	defer syscall.Close(fd)
	return mount(r.target(fd, names))
}

// bindIn binds src over the folder (dir) or file at rel in the root.
func (r *rootFS) bindIn(src, rel string, dir, ro, rec bool) error {
	fd, names, err := r.ensure(rel, dir, "")
	if err != nil {
		return err
	}
	err = r.bindAt(src, fd, names, ro, rec)
	_ = syscall.Close(fd)
	if err != nil {
		return fmt.Errorf("bind /%s: %w", strings.Join(names, "/"), err)
	}
	return nil
}

// bindAt binds src over fd (at names); read-only needs a remount of the new mount, opened again.
func (r *rootFS) bindAt(src string, fd int, names []string, ro, rec bool) error {
	flags := uintptr(syscall.MS_BIND)
	if rec {
		flags |= syscall.MS_REC
	}
	if err := syscall.Mount(src, r.target(fd, names), "", flags, ""); err != nil {
		return err
	}
	if !ro {
		return nil
	}
	// The mount just made: walked to again (the descriptor is the folder under it).
	top, err := r.reopen(names)
	if err != nil {
		return err
	}
	defer syscall.Close(top)
	// Flags locked by the parent namespace must be kept.
	var st syscall.Statfs_t
	extra := uintptr(0)
	if syscall.Fstatfs(top, &st) == nil {
		extra = uintptr(st.Flags) & (syscall.MS_NOSUID | syscall.MS_NODEV | syscall.MS_NOEXEC | syscall.MS_NOATIME | syscall.MS_RELATIME)
	}
	if err := syscall.Mount("", r.target(top, names), "", syscall.MS_BIND|syscall.MS_REMOUNT|syscall.MS_RDONLY|extra, ""); err != nil {
		return fmt.Errorf("read-only: %w", err)
	}
	return nil
}

// reopen: names again from the root (no link on the way: it was just walked), now the mount on it.
func (r *rootFS) reopen(names []string) (int, error) {
	if len(names) == 0 {
		return -1, errors.New("not the root itself")
	}
	fd, got, err := r.walk(strings.Join(names, "/"), false, names[0])
	if err != nil {
		return -1, err
	}
	if strings.Join(got, "/") != strings.Join(names, "/") {
		_ = syscall.Close(fd)
		return -1, &pathError{strings.Join(names, "/"), "changed while it was mounted"}
	}
	return fd, nil
}
