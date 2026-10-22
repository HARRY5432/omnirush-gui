//go:build linux

package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"
)

// The same ids as src/box/required.js shadowId (test/box-required.test.js checks the JS side).
func TestShadowIDMatchesTheLauncher(t *testing.T) {
	for rel, want := range map[string]string{".": "cdb4ee2aea69", "": "cdb4ee2aea69", "node_modules": "dba27c31aad9", "packages/web/node_modules": "093be456e0e4", "./packages//web/node_modules": "093be456e0e4"} {
		if got := shadowID(rel); got != want {
			t.Errorf("shadowID(%q) = %s, want %s", rel, got, want)
		}
	}
}

func TestFindNewLooksForUnshadowedPackagesOnly(t *testing.T) {
	root := t.TempDir()
	for _, d := range []string{"packages/a", "packages/b", "node_modules/x", ".git/y", "deep/1/2/3/4/5"} {
		if err := os.MkdirAll(filepath.Join(root, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for _, f := range []string{"package.json", "packages/a/package.json", "packages/b/package.json", "node_modules/x/package.json", ".git/y/package.json", "deep/1/2/3/4/5/package.json"} {
		_ = os.WriteFile(filepath.Join(root, f), []byte("{}"), 0o644)
	}
	shadows = shadowState{active: map[string]bool{filepath.Join(root, "node_modules"): true}}
	var plan shadowPlan
	_ = json.Unmarshal([]byte(`{"v":1,"lazy":[{"dir":"node_modules","when_any":["package.json"]}],"limits":{"entries":4000,"ms":150,"depth":4,"max":64},"skip_dirs":[".git","node_modules"]}`), &plan)
	plan.Root = root
	got := findNew(plan)
	sort.Strings(got)
	want := []string{filepath.Join(root, "packages/a/node_modules"), filepath.Join(root, "packages/b/node_modules")}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("findNew = %v, want %v (the root's is shadowed; .git, node_modules and past depth 4 are not looked in)", got, want)
	}
	if !shadowed(filepath.Join(root, "node_modules", "x", "index.js")) || shadowed(filepath.Join(root, "packages")) {
		t.Fatal("shadowed() is the shadowed folders and what is in them")
	}
}

func TestCheckShadowsWithoutAPlanDoesNothing(t *testing.T) {
	dir := t.TempDir()
	shadows = shadowState{active: map[string]bool{}}
	initShadows(config{envFile: filepath.Join(dir, "env")}, `["/p/node_modules"]`)
	if !shadows.active["/p/node_modules"] || shadows.planFile != filepath.Join(dir, "shadows.json") {
		t.Fatalf("initShadows: %v %s", shadows.active, shadows.planFile)
	}
	shadows.lastCheck = time.Time{}
	checkShadows(config{envFile: filepath.Join(dir, "env")}) // no shadows.json: no walk, no mounts
	if len(shadows.lazy) != 0 {
		t.Fatal("bound something with no plan")
	}
}

func TestWalkSkipsShadowedFolders(t *testing.T) {
	root := t.TempDir()
	_ = os.MkdirAll(filepath.Join(root, "node_modules", "pkg"), 0o755)
	_ = os.WriteFile(filepath.Join(root, "node_modules", "pkg", "index.js"), []byte("x"), 0o644)
	_ = os.MkdirAll(filepath.Join(root, ".venv", "lib"), 0o755)
	shadows = shadowState{active: map[string]bool{filepath.Join(root, "node_modules"): true}}
	entries, _ := walkPaths([]string{filepath.Join(root, "node_modules"), filepath.Join(root, ".venv")}, 1000)
	for _, e := range entries {
		if within(e.Path, filepath.Join(root, "node_modules")) {
			t.Fatalf("a shadowed folder was walked: %s", e.Path)
		}
	}
	if len(entries) != 2 {
		t.Fatalf("the .venv walk: %d entries", len(entries))
	}
	shadows = shadowState{active: map[string]bool{}}
}
