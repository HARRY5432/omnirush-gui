//go:build linux

package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestHostPathThroughTheLongestBind(t *testing.T) {
	binds := []bindSpec{{Src: "/mnt/c/Users/u/proj", Dst: "/c/Users/u/proj"}, {Src: "/home/run", Dst: "/run/omnirush"}, {Src: "/mnt/c/Users/u/proj/sub", Dst: "/c/Users/u/proj/sub"}}
	cases := map[string]string{
		"/c/Users/u/proj/node_modules":      "/mnt/c/Users/u/proj/node_modules",
		"/c/Users/u/proj/sub/node_modules":  "/mnt/c/Users/u/proj/sub/node_modules",
		"/c/Users/u/projector/node_modules": "",
		"/elsewhere/node_modules":           "",
	}
	for inside, want := range cases {
		if got := hostPath(inside, binds); got != want {
			t.Errorf("hostPath(%s) = %q, want %q", inside, got, want)
		}
	}
}

func TestPlanShadowsAndTheCleanUpOfMadeMountPoints(t *testing.T) {
	box, store, host := t.TempDir(), filepath.Join(t.TempDir(), "k"), t.TempDir()
	binds := []bindSpec{{Src: host, Dst: "/c/p"}}
	sp, err := planShadows(box, store, []string{"dba27c31aad9=/c/p/node_modules", "093be456e0e4=/c/p/packages/web/node_modules"}, binds)
	if err != nil {
		t.Fatal(err)
	}
	if len(sp.binds) != 2 || sp.binds[0].Src != filepath.Join(store, "dba27c31aad9") || sp.binds[0].Dst != "/c/p/node_modules" {
		t.Fatalf("planShadows: %+v", sp)
	}
	if fi, err := os.Stat(filepath.Join(store, "093be456e0e4")); err != nil || !fi.IsDir() {
		t.Fatal("the store folders are made")
	}
	if _, err := planShadows(box, store, []string{"../../etc=/c/p/x"}, binds); err == nil {
		t.Fatal("a shadow id is 12 hex digits")
	}
	// What init made on the host: an empty node_modules (removed), one written to since (kept).
	_ = os.MkdirAll(filepath.Join(host, "node_modules"), 0o755)
	_ = os.MkdirAll(filepath.Join(host, "packages", "web", "node_modules"), 0o755)
	_ = os.WriteFile(filepath.Join(host, "packages", "web", "node_modules", "kept"), []byte("x"), 0o644)
	made, _ := json.Marshal([]string{"/c/p/node_modules", "/c/p/packages/web/node_modules"})
	_ = os.WriteFile(filepath.Join(store, ".made.json"), made, 0o600)
	removeShadowMade(box)
	if _, err := os.Stat(filepath.Join(host, "node_modules")); !os.IsNotExist(err) {
		t.Fatal("the empty mount point is removed")
	}
	if _, err := os.Stat(filepath.Join(host, "packages", "web", "node_modules", "kept")); err != nil {
		t.Fatal("a folder with files is never removed")
	}
	data, _ := os.ReadFile(filepath.Join(store, ".made.json"))
	if string(data) != `["/c/p/packages/web/node_modules"]` {
		t.Fatalf(".made.json after: %s", data)
	}
	removeShadowMade(t.TempDir()) // no shadows.json: nothing
}
