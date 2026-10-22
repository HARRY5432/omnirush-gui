//go:build linux

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strings"
	"syscall"
	"testing"
)

// treeOf lists a folder tree (kind, mode, size, link target, content) to prove it unchanged.
func treeOf(t *testing.T, dir string) []string {
	t.Helper()
	var out []string
	_ = filepath.Walk(dir, func(p string, fi os.FileInfo, err error) error {
		if err != nil {
			out = append(out, "err "+p)
			return nil
		}
		rel, _ := filepath.Rel(dir, p)
		line := fmt.Sprintf("%s %v %d", rel, fi.Mode(), fi.Size())
		if fi.Mode()&os.ModeSymlink != 0 {
			target, _ := os.Readlink(p)
			line += " -> " + target
		} else if fi.Mode().IsRegular() {
			data, _ := os.ReadFile(p)
			line += " " + string(data)
		}
		out = append(out, line)
		return nil
	})
	sort.Strings(out)
	return out
}

// Both ways of walking: the kernel's openat2 check where it exists, and the walk alone.
func eachWalk(t *testing.T, fn func(t *testing.T, noOpenat2 bool)) {
	for _, no := range []bool{false, true} {
		t.Run(fmt.Sprintf("noOpenat2=%v", no), func(t *testing.T) { fn(t, no) })
	}
}

func testRoot(t *testing.T, path string, noOpenat2 bool) *rootFS {
	t.Helper()
	r, err := openRoot(path)
	if err != nil {
		t.Fatal(err)
	}
	r.noOpenat2 = noOpenat2
	t.Cleanup(r.Close)
	return r
}

func TestInRootLinksNeverLeaveTheRoot(t *testing.T) {
	eachWalk(t, func(t *testing.T, noOpenat2 bool) {
		root, outside := t.TempDir(), t.TempDir()
		victimFile := filepath.Join(outside, "boxd")
		_ = os.WriteFile(victimFile, []byte("host file"), 0o644)
		_ = os.MkdirAll(filepath.Join(root, "etc"), 0o755)
		_ = os.MkdirAll(filepath.Join(root, "opt", "omnirush"), 0o755)
		// The box's links, each to the host: absolute, relative with "..", through a chain.
		_ = os.Symlink(filepath.Join(outside, "run"), filepath.Join(root, "run"))
		_ = os.Symlink(outside, filepath.Join(root, "tmp"))
		_ = os.Symlink(outside, filepath.Join(root, "opt", "omnirush", "bin"))
		_ = os.Symlink("../../../../../../../../.."+outside, filepath.Join(root, "proj"))
		_ = os.Symlink("hop2", filepath.Join(root, "hop1"))
		_ = os.Symlink(outside+"/chain", filepath.Join(root, "hop2"))
		_ = os.Symlink(victimFile, filepath.Join(root, "etc", "hosts"))
		_ = os.Symlink("loop", filepath.Join(root, "loop"))
		before := treeOf(t, outside)
		r := testRoot(t, root, noOpenat2)

		for _, d := range []string{"run", "tmp", "proj/sub/dir", "hop1/x", "opt/omnirush/bin"} {
			if err := r.ensureDirIn(d); err != nil {
				t.Errorf("ensureDirIn(%s): %v", d, err)
			}
		}
		if err := r.chmodIn("tmp", 0o1777); err != nil {
			t.Errorf("chmodIn(tmp): %v", err)
		}
		if err := r.ensureFileIn("opt/omnirush/bin/boxd"); err != nil {
			t.Errorf("ensureFileIn(boxd): %v", err)
		}
		if err := r.ensureFileIn("etc/hosts"); err != nil {
			t.Errorf("ensureFileIn(etc/hosts): %v", err)
		}
		if err := r.ensureDirIn("loop/x"); err == nil {
			t.Error("a link loop was walked")
		}
		if got := treeOf(t, outside); !reflect.DeepEqual(got, before) {
			t.Errorf("outside the root changed:\n%v\nwant\n%v", got, before)
		}
		if !noOpenat2 && r.noOpenat2 && kernelAtLeast(kernelRelease(), 5, 6) {
			t.Error("openat2 was not used on a 5.6+ kernel")
		}
		// Leaf links are replaced by real ones; links on the way are followed inside the root.
		for _, p := range []string{"run", "tmp", "opt/omnirush/bin", "etc/hosts"} {
			if fi, err := os.Lstat(filepath.Join(root, p)); err != nil || fi.Mode()&os.ModeSymlink != 0 {
				t.Errorf("%s: still a link or missing (%v)", p, err)
			}
		}
		if fi, err := os.Stat(filepath.Join(root, "tmp")); err != nil || fi.Mode().Perm() != 0o777 || fi.Mode()&os.ModeSticky == 0 {
			t.Errorf("tmp mode: %v %v", fi, err)
		}
		if fi, err := os.Stat(filepath.Join(root, "opt/omnirush/bin/boxd")); err != nil || !fi.Mode().IsRegular() {
			t.Errorf("boxd file: %v", err)
		}
		for _, p := range []string{outside + "/sub/dir", outside + "/chain/x"} {
			if fi, err := os.Stat(filepath.Join(root, p)); err != nil || !fi.IsDir() {
				t.Errorf("%s not made inside the root: %v", p, err)
			}
		}
	})
}

func TestInRootRefusals(t *testing.T) {
	eachWalk(t, func(t *testing.T, noOpenat2 bool) {
		root, outside := t.TempDir(), t.TempDir()
		_ = os.MkdirAll(filepath.Join(root, "proc", "1"), 0o755)
		_ = os.WriteFile(filepath.Join(root, "file"), nil, 0o644)
		_ = os.Symlink("/proc/1", filepath.Join(root, "toproc"))
		_ = os.Symlink("../proc", filepath.Join(root, "file2"))
		r := testRoot(t, root, noOpenat2)
		r.special["proc"] = true
		for _, p := range []string{"proc/1/x", "toproc/x", "file2/1", "proc", "file/x", "/", ".", "a/.."} {
			if err := r.ensureDirIn(p); err == nil {
				t.Errorf("ensureDirIn(%q) went on", p)
			}
		}
		if err := r.ensureDirIn("file"); err == nil || !strings.Contains(err.Error(), "not a folder") {
			t.Errorf("a file where a folder goes: %v", err)
		}
		// ".." stops at the root.
		if fd, names, err := r.open("../../..", ""); err != nil || len(names) != 0 || !sameFile(fd, r.fd) {
			t.Errorf("..: %v %v", names, err)
		} else {
			syscall.Close(fd)
		}
		if entries, _ := os.ReadDir(outside); len(entries) != 0 {
			t.Errorf("outside: %v", entries)
		}
	})
}

// imageLinksFile: an image's link to its own file is left; a dangling one, or one to a folder, is not.
func TestImageLinksFile(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	_ = os.MkdirAll(filepath.Join(root, "etc"), 0o755)
	_ = os.MkdirAll(filepath.Join(root, "run", "systemd"), 0o755)
	_ = os.WriteFile(filepath.Join(root, "run", "systemd", "stub"), []byte("nameserver 1.1.1.1\n"), 0o644)
	_ = os.WriteFile(filepath.Join(outside, "resolv"), []byte("host"), 0o644)
	r := testRoot(t, root, false)
	cases := map[string]bool{"/run/systemd/stub": true, "../run/systemd/stub": true, "/run/nothing": false, "/run": false, filepath.Join(outside, "resolv"): false}
	for target, want := range cases {
		link := filepath.Join(root, "etc", "resolv.conf")
		_ = os.Remove(link)
		_ = os.Symlink(target, link)
		if got := imageLinksFile(r, "etc/resolv.conf"); got != want {
			t.Errorf("link to %s: %v, want %v", target, got, want)
		}
	}
}

// prepareRoot as root on a real overlay whose upper layer (the box's, from earlier runs) has a
// link at every path init uses: nothing outside the root changes and the box still gets its mounts.
func TestPrepareRootWithPlantedLinks(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("needs root (mounts)")
	}
	eachWalk(t, func(t *testing.T, noOpenat2 bool) {
		dir, outside, src := t.TempDir(), t.TempDir(), t.TempDir()
		lower, upper, work, merged := filepath.Join(dir, "lower"), filepath.Join(dir, "upper"), filepath.Join(dir, "work"), filepath.Join(dir, "merged")
		for _, d := range []string{lower + "/etc/apt/apt.conf.d", lower + "/var/lib", upper, work, merged, src + "/proj/pkg", src + "/store/aaaaaaaaaaaa", src + "/store/bbbbbbbbbbbb", outside + "/v"} {
			_ = os.MkdirAll(d, 0o755)
		}
		_ = os.WriteFile(src+"/boxd", []byte("boxd binary"), 0o755)
		_ = os.WriteFile(src+"/resolv", []byte("nameserver 9.9.9.9\n"), 0o644)
		_ = os.WriteFile(src+"/hosts", []byte("127.0.0.1 x\n"), 0o644)
		_ = os.WriteFile(outside+"/v/file", []byte("keep"), 0o644)
		_ = os.WriteFile(src+"/proj/package.json", []byte("{}"), 0o644)
		// The box's links in the upper layer.
		plant := map[string]string{
			"run":              outside + "/v",
			"tmp":              outside + "/v",
			"sys":              outside + "/v",
			"opt":              outside + "/v",
			"etc":              outside + "/v",
			"var/lib/omnirush": outside + "/v",
			"c":                "../../../../../../.." + outside + "/v",
			"proc":             outside + "/v/proc",
		}
		for p, target := range plant {
			_ = os.MkdirAll(filepath.Dir(filepath.Join(upper, p)), 0o755)
			if err := os.Symlink(target, filepath.Join(upper, p)); err != nil {
				t.Fatal(err)
			}
		}
		before := treeOf(t, outside)
		sp := spec{
			Boxd: src + "/boxd", Resolv: src + "/resolv", Hosts: src + "/hosts", AptRoot: true,
			Binds:       []bindSpec{{Src: src + "/proj", Dst: "/c/Users/u/proj"}},
			ShadowStore: src + "/store", ShadowProject: "/c/Users/u/proj",
			Shadows: []bindSpec{{Src: src + "/store/aaaaaaaaaaaa", Dst: "/c/Users/u/proj/node_modules"}, {Src: src + "/store/bbbbbbbbbbbb", Dst: "/c/Users/u/proj/pkg/node_modules"}},
		}
		type result struct {
			on, made []string
			mounts   string
			files    map[string]string
			err      error
		}
		done := make(chan result)
		go func() {
			runtime.LockOSThread() // never unlocked: the thread ends with its namespace
			if err := syscall.Unshare(syscall.CLONE_NEWNS); err != nil {
				done <- result{err: err}
				return
			}
			if err := syscall.Mount("", "/", "", syscall.MS_REC|syscall.MS_PRIVATE, ""); err != nil {
				done <- result{err: err}
				return
			}
			if _, err := mountOverlay(lower, upper, work, merged, ""); err != nil {
				done <- result{err: err}
				return
			}
			saved := forceNoOpenat2
			forceNoOpenat2 = noOpenat2
			on, made, err := prepareRoot(sp, merged)
			forceNoOpenat2 = saved
			res := result{on: on, made: made, err: err, files: map[string]string{}}
			if err == nil {
				// Read as the box will (in the root): a link there is the box's own business.
				rfs, _ := openRoot(merged)
				for _, p := range []string{"opt/omnirush/bin/boxd", "etc/resolv.conf", "etc/hosts", "c/Users/u/proj/package.json", "c/Users/u/proj/node_modules", "c/Users/u/proj/pkg/node_modules", "proc/self/status"} {
					fd, _, err := rfs.open(p, "proc")
					if err != nil {
						res.files[p] = err.Error()
						continue
					}
					var st syscall.Stat_t
					_ = syscall.Fstat(fd, &st)
					if st.Mode&syscall.S_IFMT == syscall.S_IFDIR {
						entries, _ := os.ReadDir(fmt.Sprintf("/proc/self/fd/%d", fd))
						res.files[p] = fmt.Sprintf("dir %d", len(entries))
					} else {
						data, err := os.ReadFile(fmt.Sprintf("/proc/self/fd/%d", fd))
						res.files[p] = fmt.Sprint(len(data) > 0, " ", strings.SplitN(string(data), "\n", 2)[0], err)
					}
					syscall.Close(fd)
				}
				rfs.Close()
			}
			data, _ := os.ReadFile("/proc/thread-self/mountinfo") // this thread's namespace
			res.mounts = string(data)
			done <- res
		}()
		r := <-done
		if r.err != nil {
			t.Fatalf("prepareRoot: %v", r.err)
		}
		if got := treeOf(t, outside); !reflect.DeepEqual(got, before) {
			t.Errorf("outside the root changed:\n%v\nwant\n%v", got, before)
		}
		want := map[string]string{
			"opt/omnirush/bin/boxd":           "true boxd binary<nil>",
			"etc/resolv.conf":                 "true nameserver 9.9.9.9<nil>",
			"etc/hosts":                       "true 127.0.0.1 x<nil>",
			"c/Users/u/proj/package.json":     "true {}<nil>",
			"c/Users/u/proj/node_modules":     "dir 0",
			"c/Users/u/proj/pkg/node_modules": "dir 0",
			"proc/self/status":                "true Name:\tgo-test-binary<nil>",
		}
		for k, v := range want {
			if k == "proc/self/status" {
				if !strings.HasPrefix(r.files[k], "true Name:") {
					t.Errorf("%s in the box: %q", k, r.files[k])
				}
				continue
			}
			if r.files[k] != v {
				t.Errorf("%s in the box: %q, want %q", k, r.files[k], v)
			}
		}
		// Every mount init made is in the root; none is on the host's folder.
		n := 0
		for _, line := range strings.Split(r.mounts, "\n") {
			f := strings.Fields(line)
			if len(f) < 5 {
				continue
			}
			if strings.HasPrefix(f[4], outside) {
				t.Errorf("a mount on the host's folder: %s", line)
			}
			if strings.HasPrefix(f[4], merged+"/") {
				n++
			}
		}
		if n < 8 {
			t.Errorf("only %d mounts in the root:\n%s", n, r.mounts)
		}
		if !strings.Contains(r.mounts, " "+merged+"/proc ") || !strings.Contains(r.mounts, " "+merged+"/sys ") || !strings.Contains(r.mounts, " "+merged+"/dev ") {
			t.Errorf("proc/dev/sys not on the real folders")
		}
		if !reflect.DeepEqual(r.on, []string{"/c/Users/u/proj/node_modules", "/c/Users/u/proj/pkg/node_modules"}) {
			t.Errorf("shadows: %v made %v", r.on, r.made)
		}
		// Init's own folders: the box's links there are gone (a link on the way is followed in the root).
		for _, p := range []string{"run", "tmp", "proc", "sys"} {
			if fi, err := os.Lstat(filepath.Join(upper, p)); err != nil || fi.Mode()&os.ModeSymlink != 0 || !fi.IsDir() {
				t.Errorf("upper %s: not a real folder (%v)", p, err)
			}
		}
	})
}
