//go:build linux

package oci

import (
	"archive/tar"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"syscall"
	"time"
)

// Store keeps unpacked images: <dir>/images/<id>/{rootfs/,image.json}.
type Store struct {
	Dir string
}

// ImageID names an unpacked image: the digest it was pinned by, per arch.
func ImageID(digest, arch string) string {
	return strings.TrimPrefix(digest, "sha256:")[:32] + "-" + ArchOf(arch)
}

// Paths of an image.
func (s Store) imageDir(id string) string { return filepath.Join(s.Dir, "images", id) }

// RootFS of an unpacked image.
func (s Store) RootFS(id string) string { return filepath.Join(s.imageDir(id), "rootfs") }

// Lookup returns an unpacked image's record, or nil.
func (s Store) Lookup(id string) *Image {
	data, err := os.ReadFile(filepath.Join(s.imageDir(id), "image.json"))
	if err != nil {
		return nil
	}
	var img Image
	if json.Unmarshal(data, &img) != nil {
		return nil
	}
	if _, err := os.Stat(s.RootFS(id)); err != nil {
		return nil
	}
	return &img
}

// Find returns the unpacked image for a reference (by digest when pinned,
// else by the last tag pulled) for arch, or nil.
func (s Store) Find(ref Ref, arch string) (*Image, string) {
	if ref.Digest != "" {
		id := ImageID(ref.Digest, arch)
		if img := s.Lookup(id); img != nil {
			return img, id
		}
		return nil, ""
	}
	data, err := os.ReadFile(s.tagFile(ref, arch))
	if err != nil {
		return nil, ""
	}
	id := strings.TrimSpace(string(data))
	if img := s.Lookup(id); img != nil {
		return img, id
	}
	return nil, ""
}

func (s Store) tagFile(ref Ref, arch string) string {
	sum := sha256.Sum256([]byte(ref.Registry + "/" + ref.Repo + ":" + ref.Tag + "|" + ArchOf(arch)))
	return filepath.Join(s.Dir, "tags", hex.EncodeToString(sum[:12]))
}

// lock takes an exclusive lock for an image id (one unpack at a time).
func (s Store) lock(id string) (func(), error) {
	dir := filepath.Join(s.Dir, "locks")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(dir, id+".lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		f.Close()
		return nil, err
	}
	return func() { _ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN); f.Close() }, nil
}

func (s Store) tmpDir() (string, error) {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	dir := filepath.Join(s.Dir, "tmp", hex.EncodeToString(b))
	return dir, os.MkdirAll(dir, 0o700)
}

// Progress hears each layer as it is unpacked.
type Progress func(layer int, of int, digest string, bytes int64)

// commit writes image.json into the unpacked folder and moves it in place.
func (s Store) commit(tmp, id string, img *Image) error {
	data, _ := json.MarshalIndent(img, "", "  ")
	if err := os.WriteFile(filepath.Join(tmp, "image.json"), append(data, '\n'), 0o644); err != nil {
		return err
	}
	dest := s.imageDir(id)
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	if _, err := os.Stat(dest); err == nil {
		// Another unpack of the same image won: keep it.
		go removeAllForce(tmp)
		return nil
	}
	return os.Rename(tmp, dest)
}

// Pull resolves ref for linux/arch, downloads and unpacks it (each layer
// verified against its digest) unless already there. Returns the image and its id.
func (s Store) Pull(ctx context.Context, c *Client, ref Ref, arch string, opt ApplyOptions, progress Progress) (*Image, string, error) {
	if img, id := s.Find(ref, arch); img != nil {
		return img, id, nil
	}
	img, err := c.Resolve(ctx, ref, arch)
	if err != nil {
		return nil, "", err
	}
	top := img.Digest
	if ref.Digest != "" {
		top = ref.Digest
	}
	id := ImageID(top, arch)
	unlock, err := s.lock(id)
	if err != nil {
		return nil, "", err
	}
	defer unlock()
	if got := s.Lookup(id); got != nil {
		_ = s.rememberTag(ref, arch, id)
		return got, id, nil
	}
	tmp, err := s.tmpDir()
	if err != nil {
		return nil, "", err
	}
	ok := false
	defer func() {
		if !ok {
			_ = removeAllForce(tmp)
		}
	}()
	u := &Unpacker{Root: filepath.Join(tmp, "rootfs"), Opt: opt}
	if err := os.MkdirAll(u.Root, 0o755); err != nil {
		return nil, "", err
	}
	for i, layer := range img.Layers {
		var lastErr error
		for attempt := 0; attempt < 3; attempt++ {
			if attempt > 0 {
				time.Sleep(time.Duration(attempt*2) * time.Second)
			}
			lastErr = s.applyBlob(ctx, c, ref, u, layer.Digest)
			if lastErr == nil || ctx.Err() != nil {
				break
			}
		}
		if lastErr != nil {
			return nil, "", fmt.Errorf("layer %d/%d: %w", i+1, len(img.Layers), lastErr)
		}
		if progress != nil {
			progress(i+1, len(img.Layers), layer.Digest, layer.Size)
		}
	}
	u.Finish()
	img.Digest = top
	if err := s.commit(tmp, id, img); err != nil {
		return nil, "", err
	}
	ok = true
	_ = s.rememberTag(ref, arch, id)
	return img, id, nil
}

// applyBlob streams one layer into the unpacker. A retry after a failure
// half-way re-applies the whole layer, which is idempotent.
func (s Store) applyBlob(ctx context.Context, c *Client, ref Ref, u *Unpacker, digest string) error {
	rc, err := c.OpenBlob(ctx, ref, digest)
	if err != nil {
		return err
	}
	defer rc.Close()
	if _, err := u.Apply(rc); err != nil {
		return err
	}
	// Read to the end so the digest is checked.
	if _, err := io.Copy(io.Discard, rc); err != nil {
		return err
	}
	return rc.Close()
}

func (s Store) rememberTag(ref Ref, arch, id string) error {
	if ref.Digest != "" || ref.Tag == "" {
		return nil
	}
	file := s.tagFile(ref, arch)
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		return err
	}
	return os.WriteFile(file, []byte(id+"\n"), 0o600)
}

// Import unpacks an image from a local archive: `docker save` output (with
// or without an OCI layout inside), an OCI layout tar, or a plain root
// filesystem tar (gzip or not; the WSL distro's). `as` is the reference to
// file it under (a rootfs tar has no digest: its sha256 is used).
func (s Store) Import(file, as, arch string, opt ApplyOptions) (*Image, string, error) {
	tmp, err := s.tmpDir()
	if err != nil {
		return nil, "", err
	}
	ok := false
	defer func() {
		if !ok {
			_ = removeAllForce(tmp)
		}
	}()
	u := &Unpacker{Root: filepath.Join(tmp, "rootfs"), Opt: opt}
	if err := os.MkdirAll(u.Root, 0o755); err != nil {
		return nil, "", err
	}
	img, err := importArchive(file, u)
	if err != nil {
		return nil, "", err
	}
	u.Finish()
	if as != "" {
		img.Ref = as
	}
	if img.Arch == "" {
		img.Arch = ArchOf(arch)
	}
	id := ImageID(img.Digest, img.Arch)
	if got := s.Lookup(id); got != nil {
		return got, id, nil
	}
	if err := s.commit(tmp, id, img); err != nil {
		return nil, "", err
	}
	ok = true
	if as != "" {
		if ref, err := ParseRef(as); err == nil {
			_ = s.rememberTag(ref, img.Arch, id)
		}
	}
	return img, id, nil
}

// archiveIndex lists the members of an archive (name -> offset is not
// kept: members are read by re-scanning, which is fine for a one-time import).
func readMember(file, name string, max int64) ([]byte, error) {
	f, err := os.Open(file)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	r, closeFn, err := Decompress(f)
	if err != nil {
		return nil, err
	}
	defer closeFn()
	tr := tar.NewReader(r)
	want := path.Clean(name)
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil, os.ErrNotExist
		}
		if err != nil {
			return nil, err
		}
		if path.Clean(strings.TrimPrefix(hdr.Name, "./")) == want {
			return io.ReadAll(io.LimitReader(tr, max))
		}
	}
}

// applyMember streams one member of the archive (a layer) into the unpacker.
func applyMember(file, name, digest string, u *Unpacker) error {
	f, err := os.Open(file)
	if err != nil {
		return err
	}
	defer f.Close()
	outer, closeFn, err := Decompress(f)
	if err != nil {
		return err
	}
	defer closeFn()
	tr := tar.NewReader(outer)
	want := path.Clean(name)
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return fmt.Errorf("%s: not in the archive", name)
		}
		if err != nil {
			return err
		}
		if path.Clean(strings.TrimPrefix(hdr.Name, "./")) != want {
			continue
		}
		var r io.Reader = tr
		var v *Verifier
		if digest != "" {
			v = NewVerifier(io.NopCloser(tr), digest)
			r = v
		}
		if _, err := u.Apply(r); err != nil {
			return err
		}
		if v != nil {
			if _, err := io.Copy(io.Discard, v); err != nil {
				return err
			}
			return v.Close()
		}
		return nil
	}
}

func importArchive(file string, u *Unpacker) (*Image, error) {
	// An OCI layout (index.json), as `docker save` writes since 25.0.
	if data, err := readMember(file, "index.json", 4<<20); err == nil {
		var idx manifest
		if json.Unmarshal(data, &idx) == nil && len(idx.Manifests) > 0 {
			return importLayout(file, idx, u)
		}
	}
	// The older `docker save` format (manifest.json).
	if data, err := readMember(file, "manifest.json", 4<<20); err == nil {
		var list []struct {
			Config   string   `json:"Config"`
			RepoTags []string `json:"RepoTags"`
			Layers   []string `json:"Layers"`
		}
		if json.Unmarshal(data, &list) == nil && len(list) > 0 && list[0].Config != "" {
			entry := list[0]
			cfg, err := readMember(file, entry.Config, 8<<20)
			if err != nil {
				return nil, err
			}
			sum := sha256.Sum256(cfg)
			img := &Image{Digest: "sha256:" + hex.EncodeToString(sum[:])}
			if len(entry.RepoTags) > 0 {
				img.Ref = entry.RepoTags[0]
			}
			if err := fillConfig(img, cfg, img.Digest); err != nil {
				return nil, err
			}
			img.Manifest = img.Digest
			for _, layer := range entry.Layers {
				if err := applyMember(file, layer, "", u); err != nil {
					return nil, err
				}
				img.Layers = append(img.Layers, Descriptor{Digest: "", MediaType: "application/vnd.docker.image.rootfs.diff.tar"})
			}
			return img, nil
		}
	}
	// A plain root filesystem tar: one layer, its own sha256 as the id.
	f, err := os.Open(file)
	if err != nil {
		return nil, err
	}
	h := sha256.New()
	if _, err := u.Apply(io.TeeReader(f, h)); err != nil {
		f.Close()
		return nil, err
	}
	_, _ = io.Copy(h, f)
	f.Close()
	digest := "sha256:" + hex.EncodeToString(h.Sum(nil))
	return &Image{Digest: digest, Manifest: digest, Config: digest, Env: []string{"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}}, nil
}

func importLayout(file string, idx manifest, u *Unpacker) (*Image, error) {
	blob := func(d string) string { return "blobs/sha256/" + strings.TrimPrefix(d, "sha256:") }
	top := idx.Manifests[0]
	img := &Image{Digest: top.Digest}
	data, err := readMember(file, blob(top.Digest), 4<<20)
	if err != nil {
		return nil, err
	}
	var m manifest
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, err
	}
	if len(m.Manifests) > 0 {
		pick, err := PickPlatform(m.Manifests, hostArch())
		if err != nil {
			pick = m.Manifests[0]
		}
		if data, err = readMember(file, blob(pick.Digest), 4<<20); err != nil {
			return nil, err
		}
		m = manifest{}
		if err := json.Unmarshal(data, &m); err != nil {
			return nil, err
		}
		img.Manifest = pick.Digest
	} else {
		img.Manifest = top.Digest
	}
	cfg, err := readMember(file, blob(m.Config.Digest), 8<<20)
	if err != nil {
		return nil, err
	}
	if err := fillConfig(img, cfg, m.Config.Digest); err != nil {
		return nil, err
	}
	for _, layer := range m.Layers {
		if _, err := LayerCompression(layer.MediaType); err != nil {
			return nil, err
		}
		if err := applyMember(file, blob(layer.Digest), layer.Digest, u); err != nil {
			return nil, err
		}
	}
	img.Layers = m.Layers
	return img, nil
}

func hostArch() string { return goruntime.GOARCH }

// FindArchive returns the image a local archive reference was unpacked as.
func (s Store) FindArchive(ref string) (*Image, string) {
	data, err := os.ReadFile(s.archiveFile(ref))
	if err != nil {
		return nil, ""
	}
	id := strings.TrimSpace(string(data))
	if img := s.Lookup(id); img != nil {
		return img, id
	}
	return nil, ""
}

// RememberArchive files an archive reference under the image it unpacked to.
func (s Store) RememberArchive(ref, id string) error {
	file := s.archiveFile(ref)
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		return err
	}
	return os.WriteFile(file, []byte(id+"\n"), 0o600)
}

func (s Store) archiveFile(ref string) string {
	sum := sha256.Sum256([]byte(ref))
	return filepath.Join(s.Dir, "tags", "archive-"+hex.EncodeToString(sum[:12]))
}
