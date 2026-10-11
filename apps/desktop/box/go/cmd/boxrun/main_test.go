//go:build linux

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestKernelAtLeast(t *testing.T) {
	cases := map[string]bool{"6.8.0-139-generic": true, "5.11.0": true, "5.10.220-1": false, "4.19.0": false, "6.6.87.2-microsoft-standard-WSL2": true, "": false}
	for rel, want := range cases {
		if got := kernelAtLeast(rel, 5, 11); got != want {
			t.Errorf("%q: %v", rel, got)
		}
	}
}

func TestParseBind(t *testing.T) {
	b, err := parseBind("/mnt/c/Users/Sam/proj=/c/Users/Sam/proj")
	if err != nil || b.Src != "/mnt/c/Users/Sam/proj" || b.Dst != "/c/Users/Sam/proj" {
		t.Fatalf("%+v %v", b, err)
	}
	if _, err := parseBind("relative-only"); err == nil {
		t.Fatal("a bind without a target was accepted")
	}
	b, _ = parseBind("/a=b=/x/y/")
	if b.Src != "/a=b" || b.Dst != "/x/y" {
		t.Fatalf("an = in the source: %+v", b)
	}
}

func TestArchiveRef(t *testing.T) {
	if f, ok := archiveRef("docker-archive:/tmp/x.tar"); !ok || f != "/tmp/x.tar" {
		t.Fatal(f, ok)
	}
	if f, ok := archiveRef("oci-archive:/mnt/c/x.tar"); !ok || f != "/mnt/c/x.tar" {
		t.Fatal(f, ok)
	}
	if _, ok := archiveRef("ghcr.io/omnirush-ai/box-base:1"); ok {
		t.Fatal("a registry reference read as an archive")
	}
	if _, ok := archiveRef("docker-archive:"); ok {
		t.Fatal("an empty archive path")
	}
}

func TestSubIDs(t *testing.T) {
	file := filepath.Join(t.TempDir(), "subuid")
	os.WriteFile(file, []byte("root:100000:65536\nsam:165536:65536\n1001:231072:1000\n"), 0o644)
	if s, c := subIDs(file, "sam", 1000); s != 165536 || c != 65536 {
		t.Fatal(s, c)
	}
	if s, c := subIDs(file, "nobody-here", 1001); s != 231072 || c != 1000 {
		t.Fatal("by uid:", s, c)
	}
	if _, c := subIDs(file, "x", 5); c != 0 {
		t.Fatal("no entry")
	}
}

func TestClassify(t *testing.T) {
	one := 1
	zero := 0
	fail := func(code, reason, detail string) probeResult { return probeResult{Code: code, Reason: reason} }
	r := classify(probeResult{AppArmor: &one}, "bwrap: setting up uid map: Permission denied", fail)
	if r.Code != "apparmor" || !strings.Contains(r.Reason, "Ubuntu 23.10+") {
		t.Fatal(r)
	}
	r = classify(probeResult{AppArmor: &zero, UsernsClone: &zero}, "bwrap: No permissions to create new namespace", fail)
	if r.Code != "userns_off" {
		t.Fatal(r)
	}
	r = classify(probeResult{AppArmor: &zero}, "bwrap: setting up uid map: Permission denied", fail)
	if r.Code != "userns_denied" {
		t.Fatal(r)
	}
}

func TestAlive(t *testing.T) {
	if alive(nil) || alive(&state{Pid: 0}) {
		t.Fatal("no pid is not alive")
	}
	// The go tool (this test's parent) is not a launcher: a reused pid is not taken for the box.
	if alive(&state{Pid: os.Getppid()}) {
		t.Fatal("a pid that is not bwrap/unshare/boxrun counted as the box")
	}
}

func TestRemoveTreeUnreadableFolders(t *testing.T) {
	root := filepath.Join(t.TempDir(), "probe")
	deep := filepath.Join(root, "work", "work", "inner")
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(deep, "f"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{deep, filepath.Join(root, "work", "work")} {
		if err := os.Chmod(dir, 0); err != nil {
			t.Fatal(err)
		}
	}
	if err := removeTree(root); err != nil {
		t.Fatalf("removeTree: %v", err)
	}
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Fatalf("%s is still there: %v", root, err)
	}
}
