//go:build linux

package main

// Build-artefact shadows (src/box/required.js; macOS/Windows hosts, boxes
// that boxrun starts as root: the WSL distro, the Lima VM). boxrun init binds
// the box's own copy of each build folder found at the start (node_modules,
// .venv, target, ...) over the project's, from the box-local store mounted
// at shadowStore. Here, before each command, a cheap bounded look for a new
// package (a package.json whose node_modules is not shadowed yet) binds one
// for it too, so `npm install` in a package made mid-chat never writes this
// machine's folder. Shadowed folders are never walked for a snapshot. The
// folders made on the host only to be mount points are removed when boxd
// ends (and by `boxrun stop` / the next `boxrun up` if it did not end cleanly).

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

// shadowStore: the box's own store inside the box (required.json shadows.store).
const shadowStore = "/var/lib/omnirush/shadows"

// madeFile lists the mount points made on the host (inside paths), for their removal.
const madeFile = shadowStore + "/.made.json"

// How often the look for new packages runs at most.
const shadowCheckEvery = 2 * time.Second

type shadowPlan struct {
	V      int      `json:"v"`
	Root   string   `json:"root"`
	Store  string   `json:"store"`
	Active []string `json:"active"`
	Lazy   []struct {
		Dir     string   `json:"dir"`
		WhenAny []string `json:"when_any"`
	} `json:"lazy"`
	Limits struct {
		Entries int `json:"entries"`
		Ms      int `json:"ms"`
		Depth   int `json:"depth"`
		Max     int `json:"max"`
	} `json:"limits"`
	SkipDirs []string `json:"skip_dirs"`
}

type lazyBind struct {
	Path string `json:"path"`
}

type shadowState struct {
	mu        sync.Mutex
	active    map[string]bool
	lazy      []lazyBind
	lastCheck time.Time
	planFile  string
	lazyFile  string
}

var shadows = shadowState{active: map[string]bool{}}

// shadowID is required.js shadowId: sha256 of the project-relative POSIX path ("." for the root), 12 hex digits.
func shadowID(rel string) string {
	parts := []string{}
	for _, p := range strings.Split(filepath.ToSlash(rel), "/") {
		if p != "" && p != "." {
			parts = append(parts, p)
		}
	}
	clean := strings.Join(parts, "/")
	if clean == "" {
		clean = "."
	}
	sum := sha256.Sum256([]byte(clean))
	return hex.EncodeToString(sum[:])[:12]
}

// initShadows takes the start's shadows (BOXD_SHADOWS, JSON list of inside paths, set by boxrun init)
// and where the launcher's plan is (shadows.json next to the env file).
func initShadows(cfg config, start string) {
	shadows.mu.Lock()
	defer shadows.mu.Unlock()
	if start != "" {
		var list []string
		if json.Unmarshal([]byte(start), &list) == nil {
			for _, p := range list {
				shadows.active[filepath.Clean(p)] = true
			}
		}
	}
	if cfg.envFile != "" {
		dir := filepath.Dir(cfg.envFile)
		shadows.planFile = filepath.Join(dir, "shadows.json")
		shadows.lazyFile = filepath.Join(dir, "shadows-lazy.json")
	}
}

// shadowed: whether p is a shadowed folder or in one.
func shadowed(p string) bool {
	shadows.mu.Lock()
	defer shadows.mu.Unlock()
	for dir := range shadows.active {
		if within(p, dir) {
			return true
		}
	}
	return false
}

func readMade() []string {
	var list []string
	if data, err := os.ReadFile(madeFile); err == nil {
		_ = json.Unmarshal(data, &list)
	}
	return list
}

func writeMade(list []string) {
	if list == nil {
		list = []string{}
	}
	data, _ := json.Marshal(list)
	tmp := madeFile + ".tmp"
	if os.WriteFile(tmp, data, 0o600) == nil {
		_ = os.Rename(tmp, madeFile)
	}
}

// checkShadows: before a command, at most every shadowCheckEvery, bind a shadow for each new
// package (lazy rules: a folder with one of when_any whose `dir` is not shadowed). Needs root in
// the box's mount namespace; without a plan (other backends, Linux hosts) it does nothing.
func checkShadows(cfg config) {
	shadows.mu.Lock()
	if shadows.planFile == "" || time.Since(shadows.lastCheck) < shadowCheckEvery {
		shadows.mu.Unlock()
		return
	}
	shadows.lastCheck = time.Now()
	planFile := shadows.planFile
	shadows.mu.Unlock()
	data, err := os.ReadFile(planFile)
	if err != nil {
		return
	}
	var plan shadowPlan
	if json.Unmarshal(data, &plan) != nil || plan.Root == "" || len(plan.Lazy) == 0 {
		return
	}
	if _, err := os.Stat(shadowStore); err != nil {
		return // no store in this box (started without shadows)
	}
	shadows.mu.Lock()
	for _, p := range plan.Active {
		shadows.active[filepath.Clean(p)] = true
	}
	count := len(shadows.active)
	shadows.mu.Unlock()
	if plan.Limits.Max > 0 && count >= plan.Limits.Max {
		return
	}
	for _, target := range findNew(plan) {
		bindNew(cfg, plan, target)
	}
}

// findNew walks the project (bounded like the start's scan) for lazy-rule folders not shadowed yet.
func findNew(plan shadowPlan) []string {
	entries, ms, depth := plan.Limits.Entries, plan.Limits.Ms, plan.Limits.Depth
	if entries <= 0 {
		entries = 4000
	}
	if ms <= 0 {
		ms = 150
	}
	if depth <= 0 {
		depth = 4
	}
	skip := map[string]bool{}
	for _, d := range plan.SkipDirs {
		skip[d] = true
	}
	deadline := time.Now().Add(time.Duration(ms) * time.Millisecond)
	seen := 0
	var out []string
	var visit func(dir string, level int)
	visit = func(dir string, level int) {
		if seen > entries || time.Now().After(deadline) {
			return
		}
		f, err := os.Open(dir)
		if err != nil {
			return
		}
		list, _ := f.Readdir(-1)
		f.Close()
		seen += len(list) + 1
		names := map[string]bool{}
		for _, fi := range list {
			if fi.Mode().IsRegular() {
				names[fi.Name()] = true
			}
		}
		for _, rule := range plan.Lazy {
			for _, m := range rule.WhenAny {
				if names[m] {
					target := filepath.Join(dir, filepath.FromSlash(rule.Dir))
					if !shadowed(target) {
						out = append(out, target)
					}
					break
				}
			}
		}
		if level >= depth {
			return
		}
		for _, fi := range list {
			name := fi.Name()
			if !fi.IsDir() || strings.HasPrefix(name, ".") || skip[name] {
				continue
			}
			child := filepath.Join(dir, name)
			if shadowed(child) {
				continue
			}
			visit(child, level+1)
		}
	}
	visit(plan.Root, 0)
	return out
}

func bindNew(cfg config, plan shadowPlan, target string) {
	rel, err := filepath.Rel(plan.Root, target)
	if err != nil || strings.HasPrefix(rel, "..") {
		return
	}
	src := filepath.Join(shadowStore, shadowID(rel))
	if err := os.MkdirAll(src, 0o755); err != nil {
		return
	}
	_ = os.Lchown(src, cfg.uid, cfg.gid)
	made := false
	if fi, err := os.Lstat(target); err != nil {
		// The parent is the project's (on this machine): only the leaf is made, as a mount point.
		if os.Mkdir(target, 0o755) != nil {
			return
		}
		made = true
	} else if !fi.IsDir() {
		return
	}
	if err := syscall.Mount(src, target, "", syscall.MS_BIND, ""); err != nil {
		if made {
			_ = os.Remove(target)
		}
		return
	}
	shadows.mu.Lock()
	shadows.active[filepath.Clean(target)] = true
	shadows.lazy = append(shadows.lazy, lazyBind{Path: filepath.ToSlash(rel)})
	lazy := append([]lazyBind(nil), shadows.lazy...)
	lazyFile := shadows.lazyFile
	shadows.mu.Unlock()
	if made {
		writeMade(append(readMade(), target))
	}
	if lazyFile != "" {
		data, _ := json.Marshal(map[string]any{"binds": lazy})
		_ = os.WriteFile(lazyFile, data, 0o644)
	}
}

// removeMade unmounts and removes the mount points made on the host (empty folders only), at boxd's end.
func removeMade() {
	list := readMade()
	if len(list) == 0 {
		return
	}
	var left []string
	for _, p := range list {
		_ = syscall.Unmount(p, syscall.MNT_DETACH)
		if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
			left = append(left, p)
		}
	}
	writeMade(left)
}
