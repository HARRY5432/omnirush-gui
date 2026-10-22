//go:build linux

package main

// Build-artefact shadows (src/box/required.js; macOS/Windows hosts): the
// box's own copy of each build folder of the project (node_modules, .venv,
// target, ...), kept in a store on the backend's own disk (the WSL distro,
// the Lima VM) and bound over the project's folder in the box, so the host's
// builds are never written and never run in the box. Only `up` as root
// (unshare) does it. A folder the host did not have is made there as an
// empty mount point; those are listed in <store>/.made.json (the same file
// boxd adds the ones it makes mid-chat to) and removed when the box stops.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// shadowStore: where the store is inside the box (required.json shadows.store; boxd's shadows.go).
const shadowStore = "/var/lib/omnirush/shadows"

var shadowIDPattern = regexp.MustCompile(`^[0-9a-f]{12}$`)

type shadowsFile struct {
	Store string     `json:"store"`
	Binds []bindSpec `json:"binds"` // the box's other binds: how an inside path maps to the host
}

type shadowSpec struct {
	store string
	binds []bindSpec
}

func nonNil(list []string) []string {
	if list == nil {
		return []string{}
	}
	return list
}

// planShadows makes the store and a folder per shadow (ID=DST), and remembers the store
// and the other binds in <box>/shadows.json for the clean-up after a kill.
func planShadows(box, store string, args []string, binds []bindSpec) (shadowSpec, error) {
	store, _ = filepath.Abs(store)
	if err := os.MkdirAll(store, 0o755); err != nil {
		return shadowSpec{}, err
	}
	out := shadowSpec{store: store}
	for _, v := range args {
		i := strings.Index(v, "=/")
		if i <= 0 || !shadowIDPattern.MatchString(v[:i]) {
			return shadowSpec{}, fmt.Errorf("bad shadow %q (ID=DST)", v)
		}
		src := filepath.Join(store, v[:i])
		if err := os.MkdirAll(src, 0o755); err != nil {
			return shadowSpec{}, err
		}
		out.binds = append(out.binds, bindSpec{Src: src, Dst: filepath.Clean(v[i+1:])})
	}
	if err := writeJSONFile(filepath.Join(box, "shadows.json"), shadowsFile{Store: store, Binds: binds}); err != nil {
		return shadowSpec{}, err
	}
	return out, nil
}

// bindShadows (init, as root, before the root switch): the store at shadowStore, then each
// shadow over its folder. A folder that cannot be shadowed is left as it is (never fails the box).
// Returns the inside paths shadowed.
func bindShadows(sp spec, in func(string) string) []string {
	if sp.ShadowStore == "" || len(sp.Shadows) == 0 {
		return nil
	}
	if err := ensureDir(in(shadowStore)); err != nil {
		fmt.Fprintf(os.Stderr, "boxrun: shadows: %v\n", err)
		return nil
	}
	if err := bind(sp.ShadowStore, in(shadowStore), false, false); err != nil {
		fmt.Fprintf(os.Stderr, "boxrun: shadows: %v\n", err)
		return nil
	}
	madeFile := filepath.Join(sp.ShadowStore, ".made.json")
	var made []string
	if data, err := os.ReadFile(madeFile); err == nil {
		_ = json.Unmarshal(data, &made)
	}
	var on []string
	for _, b := range sp.Shadows {
		target := in(b.Dst)
		madeHere := false
		if fi, err := os.Lstat(target); err != nil {
			// Only the leaf is made (its parent is the project's folder, e.g. next to package.json).
			if parent, err := os.Stat(filepath.Dir(target)); err != nil || !parent.IsDir() {
				continue
			}
			if os.Mkdir(target, 0o755) != nil {
				continue
			}
			madeHere = true
		} else if !fi.IsDir() {
			continue
		}
		if err := bind(b.Src, target, false, false); err != nil {
			fmt.Fprintf(os.Stderr, "boxrun: shadow %s: %v\n", b.Dst, err)
			if madeHere {
				_ = os.Remove(target)
			}
			continue
		}
		if madeHere {
			made = append(made, b.Dst)
		}
		on = append(on, b.Dst)
	}
	if data, err := json.Marshal(nonNil(made)); err == nil {
		_ = os.WriteFile(madeFile, data, 0o600)
	}
	return on
}

// hostPath: an inside path as this side sees it, through the bind that holds it (longest first).
func hostPath(inside string, binds []bindSpec) string {
	best := -1
	for i, b := range binds {
		if within(inside, b.Dst) && (best < 0 || len(b.Dst) > len(binds[best].Dst)) {
			best = i
		}
	}
	if best < 0 {
		return ""
	}
	rest := strings.TrimPrefix(inside, binds[best].Dst)
	return filepath.Join(binds[best].Src, rest)
}

func within(p, dir string) bool {
	return p == dir || strings.HasPrefix(p, strings.TrimSuffix(dir, "/")+"/")
}

// removeShadowMade removes the mount points this box made on the host (empty folders only:
// anything written there since stays), after the box stopped without boxd's own clean-up.
func removeShadowMade(box string) {
	data, err := os.ReadFile(filepath.Join(box, "shadows.json"))
	if err != nil {
		return
	}
	var f shadowsFile
	if json.Unmarshal(data, &f) != nil || f.Store == "" {
		return
	}
	madeFile := filepath.Join(f.Store, ".made.json")
	raw, err := os.ReadFile(madeFile)
	if err != nil {
		return
	}
	var made []string
	if json.Unmarshal(raw, &made) != nil {
		return
	}
	var left []string
	for _, inside := range made {
		host := hostPath(inside, f.Binds)
		if host == "" {
			continue
		}
		if err := os.Remove(host); err != nil && !os.IsNotExist(err) {
			left = append(left, inside)
		}
	}
	out, _ := json.Marshal(nonNil(left))
	_ = os.WriteFile(madeFile, out, 0o600)
}
