//go:build linux

package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"syscall"
	"testing"
)

func TestProjectRelOnlyThroughTheProjectBind(t *testing.T) {
	f := shadowsFile{
		Project: &bindSpec{Src: "/mnt/c/Users/u/proj", Dst: "/c/Users/u/proj"},
		Binds:   []bindSpec{{Src: "/mnt/c/Users/u/proj", Dst: "/c/Users/u/proj"}, {Src: "/home/run", Dst: "/run/omnirush"}, {Src: "/mnt/c/Users/u/other", Dst: "/c/Users/u/proj/sub"}},
	}
	cases := map[string][]string{
		"/c/Users/u/proj/node_modules":              {"node_modules"},
		"/c/Users/u/proj/packages/web/node_modules": {"packages", "web", "node_modules"},
		"/c/Users/u/proj//a/./node_modules":         {"a", "node_modules"},
		"/c/Users/u/proj":                           nil, // the project itself
		"/c/Users/u/proj/sub/node_modules":          nil, // another bind inside the project
		"/c/Users/u/proj/sub":                       nil,
		"/c/Users/u/projector/node_modules":         nil,
		"/run/omnirush/node_modules":                nil,
		"/elsewhere/node_modules":                   nil,
		"/c/Users/u/proj/../../../etc/passwd":       nil,
		"/c/Users/u/proj/a/../node_modules":         nil,
		"c/Users/u/proj/node_modules":               nil,
		"":                                          nil,
	}
	for inside, want := range cases {
		got, ok := projectRel(inside, f)
		if ok != (want != nil) || (ok && !reflect.DeepEqual(got, want)) {
			t.Errorf("projectRel(%q) = %v %v, want %v", inside, got, ok, want)
		}
	}
	if _, ok := projectRel("/c/Users/u/proj/node_modules", shadowsFile{}); ok {
		t.Error("no project bind: nothing")
	}
}

func TestLazyMatch(t *testing.T) {
	f := shadowsFile{Lazy: defaultLazyRules, Depth: 4, SkipDirs: defaultSkipDirs}
	ok := [][]string{{"node_modules"}, {"packages", "web", "node_modules"}, {"a", "b", "c", "d", "node_modules"}}
	bad := [][]string{{"build"}, {"pkg", "node_modules", "x"}, {".hidden", "node_modules"}, {"vendor", "target", "node_modules"}, {"a", "b", "c", "d", "e", "node_modules"}, {"node_modules", "x", "node_modules"}}
	for _, rel := range ok {
		if at, m, yes := lazyMatch(rel, f); !yes || at != len(rel)-1 || !reflect.DeepEqual(m, []string{"package.json"}) {
			t.Errorf("lazyMatch(%v) = %d %v %v", rel, at, m, yes)
		}
	}
	for _, rel := range bad {
		if _, _, yes := lazyMatch(rel, f); yes {
			t.Errorf("lazyMatch(%v) matched", rel)
		}
	}
	if _, _, yes := lazyMatch([]string{"node_modules"}, shadowsFile{Lazy: []lazyRule{{Dir: "node_modules", WhenAny: []string{"@host-binaries", "*.csproj"}}}}); yes {
		t.Error("a rule with no plain marker never matches")
	}
	if r, err := parseLazyRule("vendor/bundle=Gemfile, gems.rb"); err != nil || r.Dir != "vendor/bundle" || !reflect.DeepEqual(r.WhenAny, []string{"Gemfile", "gems.rb"}) {
		t.Errorf("parseLazyRule: %+v %v", r, err)
	}
	for _, v := range []string{"../x=a", "/abs=a", "x=", "=a", "."} {
		if _, err := parseLazyRule(v); err == nil {
			t.Errorf("parseLazyRule(%q) accepted", v)
		}
	}
}

func TestPlanShadowsAndTheCleanUpOfMadeMountPoints(t *testing.T) {
	box, store, host := t.TempDir(), filepath.Join(t.TempDir(), "k"), t.TempDir()
	binds := []bindSpec{{Src: host, Dst: "/c/p"}}
	sp, err := planShadows(box, store, []string{"dba27c31aad9=/c/p/node_modules", "093be456e0e4=/c/p/packages/web/node_modules"}, binds, "/c/p", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(sp.binds) != 2 || sp.binds[0].Src != filepath.Join(store, "dba27c31aad9") || sp.binds[0].Dst != "/c/p/node_modules" || sp.project != "/c/p" {
		t.Fatalf("planShadows: %+v", sp)
	}
	if fi, err := os.Stat(filepath.Join(store, "093be456e0e4")); err != nil || !fi.IsDir() {
		t.Fatal("the store folders are made")
	}
	if _, err := planShadows(box, store, []string{"../../etc=/c/p/x"}, binds, "/c/p", nil); err == nil {
		t.Fatal("a shadow id is 12 hex digits")
	}
	if _, err := planShadows(box, store, []string{"dba27c31aad9=/etc"}, binds, "/c/p", nil); err == nil {
		t.Fatal("a shadow is in the project")
	}
	if _, err := planShadows(box, store, []string{"dba27c31aad9=/c/p/../etc"}, binds, "/c/p", nil); err == nil {
		t.Fatal("a shadow has no ..")
	}
	if _, err := planShadows(box, store, []string{"dba27c31aad9=/c/p/node_modules"}, binds, "", nil); err == nil {
		t.Fatal("shadows need the project's bind")
	}
	if _, err := planShadows(box, store, []string{"dba27c31aad9=/c/p/node_modules"}, []bindSpec{{Src: host, Dst: "/c/p", RO: true}}, "/c/p", nil); err == nil {
		t.Fatal("a read-only bind is not the project's")
	}
	// A link the box left in the store is replaced, never followed.
	outside := t.TempDir()
	_ = os.RemoveAll(filepath.Join(store, "dba27c31aad9"))
	if err := os.Symlink(outside, filepath.Join(store, "dba27c31aad9")); err != nil {
		t.Fatal(err)
	}
	if _, err := planShadows(box, store, []string{"dba27c31aad9=/c/p/node_modules", "093be456e0e4=/c/p/packages/web/node_modules"}, binds, "/c/p", nil); err != nil {
		t.Fatal(err)
	}
	if fi, err := os.Lstat(filepath.Join(store, "dba27c31aad9")); err != nil || !fi.IsDir() {
		t.Fatal("the store folder is a real folder again")
	}
	if _, err := os.Stat(outside); err != nil {
		t.Fatal("the link's target is left alone")
	}
	// What init made on the host: an empty node_modules (removed), one written to since (kept).
	_ = os.MkdirAll(filepath.Join(host, "node_modules"), 0o755)
	_ = os.MkdirAll(filepath.Join(host, "packages", "web", "node_modules"), 0o755)
	_ = os.WriteFile(filepath.Join(host, "packages", "web", "node_modules", "kept"), []byte("x"), 0o644)
	recordShadowMade(box, []string{"/c/p/node_modules", "/c/p/packages/web/node_modules"})
	removeShadowMade(box)
	if _, err := os.Stat(filepath.Join(host, "node_modules")); !os.IsNotExist(err) {
		t.Fatal("the empty mount point is removed")
	}
	if _, err := os.Stat(filepath.Join(host, "packages", "web", "node_modules", "kept")); err != nil {
		t.Fatal("a folder with files is never removed")
	}
	f, _ := readShadowsFile(box)
	if !reflect.DeepEqual(f.Made, []string{"/c/p/packages/web/node_modules"}) {
		t.Fatalf("shadows.json made after: %v", f.Made)
	}
	// The next plan keeps the list of the ones not removed yet.
	if _, err := planShadows(box, store, []string{"dba27c31aad9=/c/p/node_modules"}, binds, "/c/p", nil); err != nil {
		t.Fatal(err)
	}
	if f, _ := readShadowsFile(box); !reflect.DeepEqual(f.Made, []string{"/c/p/packages/web/node_modules"}) {
		t.Fatalf("shadows.json made after a new plan: %v", f.Made)
	}
	// init.json's list counts too (up did not get to record it).
	_ = os.MkdirAll(filepath.Join(host, "x", "node_modules"), 0o755)
	_ = os.WriteFile(filepath.Join(box, "init.json"), []byte(`{"made":["/c/p/x/node_modules","/c/p/../../etc"]}`), 0o600)
	removeShadowMade(box)
	if _, err := os.Stat(filepath.Join(host, "x", "node_modules")); !os.IsNotExist(err) {
		t.Fatal("init.json's made folder is removed")
	}
	removeShadowMade(t.TempDir()) // no shadows.json: nothing
}

func TestCleanUpNeverTrustsTheBoxList(t *testing.T) {
	box, store, host, run, nested := t.TempDir(), filepath.Join(t.TempDir(), "k"), t.TempDir(), t.TempDir(), t.TempDir()
	victim := t.TempDir() // outside the project: nothing in it may go
	mk := func(p string) {
		if err := os.MkdirAll(p, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	file := func(p string) {
		mk(filepath.Dir(p))
		if err := os.WriteFile(p, []byte("{}"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	binds := []bindSpec{{Src: host, Dst: "/c/p"}, {Src: run, Dst: "/run/omnirush"}, {Src: nested, Dst: "/c/p/sub"}}
	if _, err := planShadows(box, store, []string{"dba27c31aad9=/c/p/node_modules"}, binds, "/c/p", nil); err != nil {
		t.Fatal(err)
	}
	// Outside the project.
	file(filepath.Join(victim, "passwd"))
	mk(filepath.Join(victim, "empty"))
	file(filepath.Join(victim, "package.json"))
	mk(filepath.Join(victim, "node_modules"))
	// Through another bind (the run folder) and a bind inside the project.
	file(filepath.Join(run, "package.json"))
	mk(filepath.Join(run, "node_modules"))
	file(filepath.Join(nested, "package.json"))
	mk(filepath.Join(nested, "node_modules"))
	// In the project: a link, a file, a full folder, a linked parent, rule misses.
	file(filepath.Join(host, "a", "package.json"))
	_ = os.Symlink(filepath.Join(victim, "empty"), filepath.Join(host, "a", "node_modules"))
	file(filepath.Join(host, "b", "package.json"))
	file(filepath.Join(host, "b", "node_modules"))
	file(filepath.Join(host, "c", "package.json"))
	file(filepath.Join(host, "c", "node_modules", "left-pad", "index.js"))
	_ = os.Symlink(victim, filepath.Join(host, "evil"))
	mk(filepath.Join(host, "nopkg", "node_modules"))
	file(filepath.Join(host, "f", "package.json"))
	mk(filepath.Join(host, "f", "build"))
	file(filepath.Join(host, ".hidden", "package.json"))
	mk(filepath.Join(host, ".hidden", "node_modules"))
	file(filepath.Join(host, "a1", "a2", "a3", "a4", "a5", "package.json"))
	mk(filepath.Join(host, "a1", "a2", "a3", "a4", "a5", "node_modules"))
	mk(filepath.Join(host, "dirpkg", "package.json"))
	mk(filepath.Join(host, "dirpkg", "node_modules"))
	// The start's shadow over the host's own (empty) node_modules: not made, never removed.
	file(filepath.Join(host, "package.json"))
	mk(filepath.Join(host, "node_modules"))
	// Legit: a package made mid-chat and its empty mount point.
	file(filepath.Join(host, "packages", "api", "package.json"))
	mk(filepath.Join(host, "packages", "api", "node_modules"))

	rel, _ := filepath.Rel("/", victim)
	list := []string{
		"/c/p/../../" + rel + "/passwd",
		"/c/p/../../../../../../../../" + rel + "/empty",
		"../../etc/passwd",
		filepath.Join(victim, "empty"),
		filepath.Join(victim, "node_modules"),
		"/run/omnirush/node_modules",
		"/c/p/sub/node_modules",
		"/c/p/a/node_modules",
		"/c/p/b/node_modules",
		"/c/p/c/node_modules",
		"/c/p/evil/node_modules",
		"/c/p/nopkg/node_modules",
		"/c/p/f/build",
		"/c/p/.hidden/node_modules",
		"/c/p/a1/a2/a3/a4/a5/node_modules",
		"/c/p/dirpkg/node_modules",
		"/c/p/node_modules",
		"/c/p",
		"/c/p/packages/api/node_modules",
	}
	data, _ := json.Marshal(list)
	if err := os.WriteFile(filepath.Join(store, ".made.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	removeShadowMade(box)

	for _, p := range []string{
		filepath.Join(victim, "passwd"), filepath.Join(victim, "empty"), filepath.Join(victim, "node_modules"),
		filepath.Join(run, "node_modules"), filepath.Join(nested, "node_modules"),
		filepath.Join(host, "b", "node_modules"), filepath.Join(host, "c", "node_modules", "left-pad", "index.js"),
		filepath.Join(host, "nopkg", "node_modules"), filepath.Join(host, "f", "build"), filepath.Join(host, ".hidden", "node_modules"),
		filepath.Join(host, "a1", "a2", "a3", "a4", "a5", "node_modules"), filepath.Join(host, "dirpkg", "node_modules"),
		filepath.Join(host, "node_modules"), host,
	} {
		if _, err := os.Lstat(p); err != nil {
			t.Errorf("%s was removed: %v", p, err)
		}
	}
	if fi, err := os.Lstat(filepath.Join(host, "a", "node_modules")); err != nil || fi.Mode()&os.ModeSymlink == 0 {
		t.Error("a link entry is left as it is")
	}
	if _, err := os.Stat(filepath.Join(host, "packages", "api", "node_modules")); !os.IsNotExist(err) {
		t.Error("a mid-chat mount point the lazy rules allow is removed")
	}
	if _, err := os.Lstat(filepath.Join(store, ".made.json")); !os.IsNotExist(err) {
		t.Error("the box's list is done with")
	}

	// A link as the box's list: neither read nor written through.
	file(filepath.Join(host, "packages", "web", "package.json"))
	mk(filepath.Join(host, "packages", "web", "node_modules"))
	target := filepath.Join(victim, "list.json")
	_ = os.WriteFile(target, []byte(`["/c/p/packages/web/node_modules"]`), 0o644)
	_ = os.Symlink(target, filepath.Join(store, ".made.json"))
	removeShadowMade(box)
	if _, err := os.Stat(filepath.Join(host, "packages", "web", "node_modules")); err != nil {
		t.Error("a list behind a link is not read")
	}
	if data, err := os.ReadFile(target); err != nil || string(data) != `["/c/p/packages/web/node_modules"]` {
		t.Errorf("the link's target is left alone: %s %v", data, err)
	}
}

func TestRemoveEmptyDirNeverFollowsALink(t *testing.T) {
	root, victim := t.TempDir(), t.TempDir()
	_ = os.MkdirAll(filepath.Join(victim, "x", "node_modules"), 0o755)
	_ = os.Symlink(victim, filepath.Join(root, "l"))
	if r := removeEmptyDir(root, []string{"l", "x", "node_modules"}, 0, nil); r != refusedDir {
		t.Errorf("through a link: %v", r)
	}
	if _, err := os.Stat(filepath.Join(victim, "x", "node_modules")); err != nil {
		t.Error("removed through a link")
	}
	if r := removeEmptyDir(root, []string{"gone", "node_modules"}, 0, nil); r != removedDir {
		t.Errorf("a missing one is done: %v", r)
	}
}

// bindShadows binds as root: run in a mount namespace of its own (one locked thread), with sudo.
func TestBindShadowsStaysInTheProject(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("needs root (mounts)")
	}
	rootfs, store, outside := t.TempDir(), t.TempDir(), t.TempDir()
	proj := filepath.Join(rootfs, "c", "p")
	for _, d := range []string{filepath.Join(proj, "pkg"), filepath.Join(store, "aaaaaaaaaaaa"), filepath.Join(store, "bbbbbbbbbbbb"), filepath.Join(store, "cccccccccccc")} {
		_ = os.MkdirAll(d, 0o755)
	}
	_ = os.Symlink(outside, filepath.Join(proj, "evil"))
	victim := filepath.Join(outside, "victim")
	_ = os.WriteFile(victim, []byte("keep"), 0o644)
	_ = os.Symlink(victim, filepath.Join(store, ".made.json"))
	sp := spec{ShadowStore: store, ShadowProject: "/c/p", Shadows: []bindSpec{
		{Src: filepath.Join(store, "aaaaaaaaaaaa"), Dst: "/c/p/pkg/node_modules"},
		{Src: filepath.Join(store, "bbbbbbbbbbbb"), Dst: "/c/p/evil/node_modules"},
		{Src: filepath.Join(store, "cccccccccccc"), Dst: "/elsewhere/node_modules"},
	}}
	type result struct {
		on, made []string
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
		r, err := openRoot(rootfs)
		if err != nil {
			done <- result{err: err}
			return
		}
		defer r.Close()
		on, made := bindShadows(sp, r)
		done <- result{on: on, made: made}
	}()
	r := <-done
	if r.err != nil {
		t.Skipf("no mount namespace: %v", r.err)
	}
	if !reflect.DeepEqual(r.on, []string{"/c/p/pkg/node_modules"}) || !reflect.DeepEqual(r.made, []string{"/c/p/pkg/node_modules"}) {
		t.Fatalf("bindShadows: on %v made %v", r.on, r.made)
	}
	if _, err := os.Lstat(filepath.Join(outside, "node_modules")); !os.IsNotExist(err) {
		t.Error("a folder was made through a link out of the project")
	}
	if data, _ := os.ReadFile(victim); string(data) != "keep" {
		t.Errorf("the store's list was written through a link: %q", data)
	}
	if data, err := os.ReadFile(filepath.Join(store, ".made.json")); err != nil || string(data) != `["/c/p/pkg/node_modules"]` {
		t.Errorf("the store's list for boxd: %s %v", data, err)
	}
}
