//go:build linux

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"
)

// mountOverlay mounts lower+upper at merged: the kernel's overlayfs (in a
// user namespace: 5.11+, with userxattr), else fuse-overlayfs when given.
// Returns "kernel" or "fuse".
func mountOverlay(lower, upper, work, merged, fuse string) (string, error) {
	return mountOverlayMode(lower, upper, work, merged, fuse, false)
}

func mountOverlayMode(lower, upper, work, merged, fuse string, noKernel bool) (string, error) {
	base := fmt.Sprintf("lowerdir=%s,upperdir=%s,workdir=%s", lower, upper, work)
	var errs []string
	kernel := []string{base + ",userxattr", base}
	if noKernel {
		kernel = nil
		errs = append(errs, "kernel overlay skipped")
	}
	for _, opts := range kernel {
		err := syscall.Mount("overlay", merged, "overlay", 0, opts)
		if err == nil {
			return "kernel", nil
		}
		errs = append(errs, err.Error())
	}
	if fuse != "" {
		if _, err := os.Stat("/dev/fuse"); err == nil {
			cmd := exec.Command(fuse, "-o", base, merged)
			out, err := cmd.CombinedOutput()
			if err == nil {
				return "fuse", nil
			}
			errs = append(errs, fmt.Sprintf("fuse-overlayfs: %v %s", err, strings.TrimSpace(string(out))))
		} else {
			errs = append(errs, "no /dev/fuse")
		}
	}
	return "", errors.New("overlay: " + strings.Join(errs, "; "))
}

func ensureDir(p string) error {
	if fi, err := os.Lstat(p); err == nil {
		if fi.IsDir() {
			return nil
		}
		return fmt.Errorf("%s is not a folder", p)
	}
	return os.MkdirAll(p, 0o755)
}

// stageInit runs inside the namespaces as root: overlay root, the project
// and run folders, /proc /dev /sys, DNS, then the root switch and boxd.
func stageInit(args []string) error {
	if len(args) < 1 {
		return errors.New("init: no spec")
	}
	data, err := os.ReadFile(args[0])
	if err != nil {
		return err
	}
	var sp spec
	if err := json.Unmarshal(data, &sp); err != nil {
		return err
	}
	t0 := time.Now()
	if sp.Root {
		// unshare(1) as real root: nothing may leak back to the distro's mounts.
		_ = syscall.Mount("", "/", "", syscall.MS_REC|syscall.MS_PRIVATE, "")
	}
	if sp.Hostname != "" {
		_ = syscall.Sethostname([]byte(sp.Hostname))
	}
	m := sp.Merged
	if err := ensureDir(m); err != nil {
		return err
	}
	overlay, err := mountOverlayMode(sp.Lower, sp.Upper, sp.Work, m, sp.Fuse, sp.NoKernel)
	if err != nil {
		return err
	}
	shadowsOn, shadowsMade, err := prepareRoot(sp, m)
	if err != nil {
		return err
	}
	if len(shadowsOn) > 0 {
		list, _ := json.Marshal(shadowsOn)
		sp.Env = append(sp.Env, "BOXD_SHADOWS="+string(list))
	}
	if sp.InitOut != "" {
		info, _ := json.Marshal(map[string]any{"overlay": overlay, "ms": time.Since(t0).Milliseconds(), "shadows": nonNil(shadowsOn), "made": nonNil(shadowsMade)})
		_ = os.WriteFile(sp.InitOut, info, 0o600)
	}
	// Switch root: pivot_root(".", ".") stacks the old root on the new one;
	// detaching it leaves only the box.
	if err := os.Chdir(m); err != nil {
		return err
	}
	if err := syscall.PivotRoot(".", "."); err != nil {
		return fmt.Errorf("pivot_root: %w", err)
	}
	if err := syscall.Unmount(".", syscall.MNT_DETACH); err != nil {
		return fmt.Errorf("detach old root: %w", err)
	}
	if err := os.Chdir("/"); err != nil {
		return err
	}
	return syscall.Exec("/opt/omnirush/bin/boxd", []string{"boxd"}, sp.Env)
}

// prepareRoot fills the mounted root m (inroot.go: nothing here follows a link the box left
// out of it): the command folders, /proc /dev /sys, boxd, DNS, the binds and the shadows.
func prepareRoot(sp spec, m string) (shadowsOn, shadowsMade []string, err error) {
	r, err := openRoot(m)
	if err != nil {
		return nil, nil, err
	}
	defer r.Close()
	// The command folders boxd and the launcher use. They are made once, in
	// the upper layer, before boxd's first index, so they are no change.
	for _, d := range []string{"proc", "dev", "sys", "tmp", "run", "opt/omnirush/bin"} {
		if err := r.ensureDirIn(d); err != nil {
			return nil, nil, err
		}
	}
	_ = r.chmodIn("tmp", 0o1777)
	err = r.mountIn("proc", true, "", func(target string) error {
		return syscall.Mount("proc", target, "proc", syscall.MS_NOSUID|syscall.MS_NODEV|syscall.MS_NOEXEC, "")
	})
	if err != nil {
		// Some kernels refuse a fresh proc while the host's is partly covered: bind the namespace's own.
		if err2 := r.bindIn("/proc", "proc", true, false, true); err2 != nil {
			return nil, nil, fmt.Errorf("proc: %v; %v", err, err2)
		}
	}
	r.special["proc"] = true
	if err := r.bindIn("/dev", "dev", true, false, true); err != nil {
		return nil, nil, err
	}
	r.special["dev"] = true
	if fd, names, err := r.open("dev/shm", "dev"); err == nil {
		var st syscall.Stat_t
		if syscall.Fstat(fd, &st) == nil && st.Mode&syscall.S_IFMT == syscall.S_IFDIR && len(names) > 0 && names[0] == "dev" {
			_ = syscall.Mount("tmpfs", r.target(fd, names), "tmpfs", syscall.MS_NOSUID|syscall.MS_NODEV, "mode=1777")
		}
		_ = syscall.Close(fd)
	}
	if err := r.bindIn("/sys", "sys", true, true, true); err != nil {
		// /sys is only read by a few tools: go on without it.
		fmt.Fprintf(os.Stderr, "boxrun: %v\n", err)
	}
	r.special["sys"] = true
	if err := r.bindIn(sp.Boxd, "opt/omnirush/bin/boxd", false, true, false); err != nil {
		return nil, nil, err
	}
	for _, f := range []struct{ src, dst string }{{sp.Resolv, "etc/resolv.conf"}, {sp.Hosts, "etc/hosts"}} {
		if f.src == "" {
			continue
		}
		if _, err := os.Stat(f.src); err != nil {
			continue
		}
		if imageLinksFile(r, f.dst) {
			continue // the image links it to a file of its own: leave it
		}
		if err := r.bindIn(f.src, f.dst, false, true, false); err != nil {
			fmt.Fprintf(os.Stderr, "boxrun: %v\n", err)
		}
	}
	for _, b := range sp.Binds {
		fi, err := os.Stat(b.Src)
		if err != nil {
			return nil, nil, fmt.Errorf("bind source %s: %w", b.Dst, err)
		}
		if err := r.bindIn(b.Src, b.Dst, fi.IsDir(), b.RO, true); err != nil {
			return nil, nil, err
		}
	}
	// The box's own build folders, over the project's (after its bind: they are inside it).
	shadowsOn, shadowsMade = bindShadows(sp, r)
	if sp.AptRoot {
		// One uid is mapped (the user's, as root): apt cannot drop to _apt.
		if fd, _, err := r.open("etc/apt/apt.conf.d", ""); err == nil {
			if mode, err := statAt(fd, "."); err == nil && mode == syscall.S_IFDIR {
				if f, err := syscall.Openat(fd, "00omnirush-box", syscall.O_CREAT|syscall.O_EXCL|syscall.O_WRONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0o644); err == nil {
					_, _ = syscall.Write(f, []byte("APT::Sandbox::User \"root\";\n"))
					_ = syscall.Close(f)
				}
			}
			_ = syscall.Close(fd)
		}
	}
	return shadowsOn, shadowsMade, nil
}

// imageLinksFile: rel is a link (the image's, or the box's) to a file in the root, followed
// inside it as the box will: left alone. A link to nothing, a folder or init's mounts is
// replaced by the real file.
func imageLinksFile(r *rootFS, rel string) bool {
	pfd, _, name, err := r.parent(rel, "")
	if err != nil {
		return false
	}
	mode, err := statAt(pfd, name)
	_ = syscall.Close(pfd)
	if err != nil || mode != syscall.S_IFLNK {
		return false
	}
	fd, _, err := r.open(rel, "")
	if err != nil {
		return false
	}
	defer syscall.Close(fd)
	var st syscall.Stat_t
	return syscall.Fstat(fd, &st) == nil && st.Mode&syscall.S_IFMT == syscall.S_IFREG
}
