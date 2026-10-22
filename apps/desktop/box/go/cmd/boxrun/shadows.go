//go:build linux

package main

// Build-artefact shadows (src/box/required.js; macOS/Windows hosts): the
// box's own copy of each build folder of the project (node_modules, .venv,
// target, ...), kept in a store on the backend's own disk (the WSL distro,
// the Lima VM) and bound over the project's folder in the box, so the host's
// builds are never written and never run in the box. Only `up` as root
// (unshare) does it. A folder the host did not have is made there as an
// empty mount point and removed when the box stops.
//
// The store is the box's (mounted at shadowStore inside, writable there), so
// nothing in it is trusted on this side: <store>/.made.json is only for
// boxd's own clean-up in the box. What this side removes comes from
// <box>/shadows.json (the box folder is never bound into the box): the mount
// points init made, recorded from init.json, and the ones boxd made mid-chat
// only when they still match the lazy rules recorded there at plan time.
// Each is removed through the project's bind only, walking from the
// project's real folder without following a link, and only if it is an
// empty folder.

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"unsafe"
)

// shadowStore: where the store is inside the box (required.json shadows.store; boxd's shadows.go).
const shadowStore = "/var/lib/omnirush/shadows"

// madeFileName: in the store, boxd's list of the mount points made on the host (box-writable).
const madeFileName = ".made.json"

var shadowIDPattern = regexp.MustCompile(`^[0-9a-f]{12}$`)

// lazyRule is a folder boxd may make mid-chat (required.json shadows.binds with even_if_absent):
// `dir` next to one of `when_any`.
type lazyRule struct {
	Dir     string   `json:"dir"`
	WhenAny []string `json:"when_any"`
}

// The lazy rules, depth and skipped folders of required.json shadows (boxd's findNew), used
// when `up` is not given --shadow-lazy.
var (
	defaultLazyRules = []lazyRule{{Dir: "node_modules", WhenAny: []string{"package.json"}}}
	defaultLazyDepth = 4
	defaultSkipDirs  = []string{".git", "node_modules", ".venv", "venv", "target", ".hg", ".svn"}
)

// parseLazyRule: DIR=MARKER[,MARKER...] (--shadow-lazy).
func parseLazyRule(v string) (lazyRule, error) {
	i := strings.Index(v, "=")
	if i <= 0 || i == len(v)-1 {
		return lazyRule{}, fmt.Errorf("bad lazy shadow %q (DIR=MARKER[,MARKER])", v)
	}
	dir := filepath.Clean(v[:i])
	if filepath.IsAbs(dir) || dir == "." || hasDotDot(dir) {
		return lazyRule{}, fmt.Errorf("bad lazy shadow %q (DIR=MARKER[,MARKER])", v)
	}
	var markers []string
	for _, m := range strings.Split(v[i+1:], ",") {
		if m = strings.TrimSpace(m); m != "" {
			markers = append(markers, m)
		}
	}
	return lazyRule{Dir: dir, WhenAny: markers}, nil
}

type shadowsFile struct {
	Store string     `json:"store"`
	Binds []bindSpec `json:"binds"` // all the box's binds (the project's and the others)
	// The project's bind: mount points are removed through it only.
	Project *bindSpec `json:"project,omitempty"`
	// The start's shadows (inside paths): never removed unless init made them.
	Shadows []string `json:"shadows,omitempty"`
	// The mount points init made (inside paths), from init.json, still to remove.
	Made []string `json:"made,omitempty"`
	// What boxd may make mid-chat (a .made.json entry is removed only when it matches).
	Lazy     []lazyRule `json:"lazy,omitempty"`
	Depth    int        `json:"depth,omitempty"`
	SkipDirs []string   `json:"skip_dirs,omitempty"`
}

type shadowSpec struct {
	store   string
	project string
	binds   []bindSpec
}

func nonNil(list []string) []string {
	if list == nil {
		return []string{}
	}
	return list
}

func hasDotDot(p string) bool {
	for _, c := range strings.Split(p, "/") {
		if c == ".." {
			return true
		}
	}
	return false
}

func readShadowsFile(box string) (shadowsFile, bool) {
	var f shadowsFile
	data, err := os.ReadFile(filepath.Join(box, "shadows.json"))
	if err != nil || json.Unmarshal(data, &f) != nil || f.Store == "" {
		return shadowsFile{}, false
	}
	return f, true
}

// planShadows makes the store and a folder per shadow (ID=DST), and remembers in
// <box>/shadows.json the store, the binds, the project's bind (the one whose inside path is
// `project`, BOXD_ROOT), the shadows and the lazy rules, for the clean-up after a kill.
func planShadows(box, store string, args []string, binds []bindSpec, project string, lazy []lazyRule) (shadowSpec, error) {
	store, _ = filepath.Abs(store)
	var proj *bindSpec
	if project != "" {
		project = filepath.Clean(project)
		for i := range binds {
			if !binds[i].RO && binds[i].Dst == project {
				b := binds[i]
				proj = &b
				break
			}
		}
	}
	if proj == nil || !filepath.IsAbs(proj.Dst) || proj.Dst == "/" {
		return shadowSpec{}, errors.New("shadows: no writable bind for the project (BOXD_ROOT)")
	}
	if err := os.MkdirAll(store, 0o755); err != nil {
		return shadowSpec{}, err
	}
	out := shadowSpec{store: store, project: proj.Dst}
	var dsts []string
	for _, v := range args {
		i := strings.Index(v, "=/")
		if i <= 0 || !shadowIDPattern.MatchString(v[:i]) {
			return shadowSpec{}, fmt.Errorf("bad shadow %q (ID=DST)", v)
		}
		dst := filepath.Clean(v[i+1:])
		if hasDotDot(v[i+1:]) || dst == proj.Dst || !within(dst, proj.Dst) {
			return shadowSpec{}, fmt.Errorf("bad shadow %q (not in the project)", v)
		}
		src := filepath.Join(store, v[:i])
		// The store is the box's: a link left there is never followed (bound over the project).
		if fi, err := os.Lstat(src); err == nil && !fi.IsDir() {
			if err := os.Remove(src); err != nil {
				return shadowSpec{}, err
			}
		}
		if err := os.Mkdir(src, 0o755); err != nil && !os.IsExist(err) {
			return shadowSpec{}, err
		}
		if fi, err := os.Lstat(src); err != nil || !fi.IsDir() {
			return shadowSpec{}, fmt.Errorf("shadow store %s is not a folder", src)
		}
		out.binds = append(out.binds, bindSpec{Src: src, Dst: dst})
		dsts = append(dsts, dst)
	}
	if lazy == nil {
		lazy = defaultLazyRules
	}
	f := shadowsFile{Store: store, Binds: binds, Project: proj, Shadows: dsts, Lazy: lazy, Depth: defaultLazyDepth, SkipDirs: defaultSkipDirs}
	// Mount points an earlier run made and could not remove (not empty) are kept on the list.
	if old, ok := readShadowsFile(box); ok && old.Project != nil && *old.Project == *proj {
		f.Made = old.Made
	}
	if err := writeJSONFile(filepath.Join(box, "shadows.json"), f); err != nil {
		return shadowSpec{}, err
	}
	return out, nil
}

// recordShadowMade adds the mount points init made (init.json "made") to <box>/shadows.json.
func recordShadowMade(box string, made []string) {
	if len(made) == 0 {
		return
	}
	f, ok := readShadowsFile(box)
	if !ok {
		return
	}
	f.Made = union(f.Made, made)
	_ = writeJSONFile(filepath.Join(box, "shadows.json"), f)
}

func union(a, b []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, list := range [][]string{a, b} {
		for _, p := range list {
			if !seen[p] {
				seen[p] = true
				out = append(out, p)
			}
		}
	}
	return out
}

// bindShadows (init, as root, before the root switch): the store at shadowStore, then each
// shadow over its folder. A folder that cannot be shadowed is left as it is (never fails the box).
// Every path is walked in the box's root (inroot.go), and a shadow's folder must really be in the
// project's. Returns the inside paths shadowed and the ones made here as mount points.
func bindShadows(sp spec, r *rootFS) (on, made []string) {
	if sp.ShadowStore == "" || len(sp.Shadows) == 0 || sp.ShadowProject == "" {
		return nil, nil
	}
	if err := r.bindIn(sp.ShadowStore, shadowStore, true, false, false); err != nil {
		fmt.Fprintf(os.Stderr, "boxrun: shadows: %v\n", err)
		return nil, nil
	}
	pfd, projNames, err := r.open(sp.ShadowProject, "")
	if err != nil {
		fmt.Fprintf(os.Stderr, "boxrun: shadows: %v\n", err)
		return nil, nil
	}
	_ = syscall.Close(pfd)
	projReal := "/" + strings.Join(projNames, "/")
	for _, b := range sp.Shadows {
		if b.Dst == sp.ShadowProject || !within(b.Dst, sp.ShadowProject) {
			continue
		}
		// A link in the project (written by the box) must not take the folder elsewhere.
		dfd, dirNames, err := r.open(filepath.Dir(b.Dst), "")
		if err != nil {
			continue
		}
		parentReal := "/" + strings.Join(dirNames, "/")
		name := filepath.Base(b.Dst)
		if !within(parentReal, projReal) || name == "." || name == ".." || name == "/" {
			_ = syscall.Close(dfd)
			continue
		}
		names := append(append([]string{}, dirNames...), name)
		madeHere := false
		mode, err := statAt(dfd, name)
		if err == syscall.ENOENT {
			// Only the leaf is made (its parent is the project's folder, e.g. next to package.json).
			if syscall.Mkdirat(dfd, name, 0o755) != nil {
				_ = syscall.Close(dfd)
				continue
			}
			madeHere = true
		} else if err != nil || mode != syscall.S_IFDIR {
			_ = syscall.Close(dfd)
			continue
		}
		fd, err := syscall.Openat(dfd, name, oPath|syscall.O_NOFOLLOW|syscall.O_DIRECTORY|syscall.O_CLOEXEC, 0)
		if err == nil {
			err = r.check(fd, names)
			if err == nil {
				err = r.bindAt(b.Src, fd, names, false, false)
			}
			_ = syscall.Close(fd)
		}
		if err != nil {
			fmt.Fprintf(os.Stderr, "boxrun: shadow %s: %v\n", b.Dst, err)
			if madeHere {
				_ = rmdirAt(dfd, name)
			}
			_ = syscall.Close(dfd)
			continue
		}
		_ = syscall.Close(dfd)
		if madeHere {
			// Recorded where it really is (a link inside the project may have led there).
			if rel, err := filepath.Rel(projReal, "/"+strings.Join(names, "/")); err == nil && rel != "." && !hasDotDot(rel) {
				made = append(made, filepath.Join(sp.ShadowProject, rel))
			}
		}
		on = append(on, b.Dst)
	}
	// For boxd's own clean-up in the box. The store is the box's: never write through a link left there.
	madeFile := filepath.Join(sp.ShadowStore, madeFileName)
	_ = os.Remove(madeFile)
	if data, err := json.Marshal(nonNil(made)); err == nil {
		if fh, err := os.OpenFile(madeFile, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0o600); err == nil {
			_, _ = fh.Write(data)
			_ = fh.Close()
		}
	}
	return on, made
}

func within(p, dir string) bool {
	return p == dir || strings.HasPrefix(p, strings.TrimSuffix(dir, "/")+"/")
}

// projectRel: an inside path below the project's bind as its components, or false when it is
// not absolute, has a `..`, is not strictly in the project, or is in another bind inside it.
func projectRel(inside string, f shadowsFile) ([]string, bool) {
	if f.Project == nil || inside == "" || !filepath.IsAbs(inside) || hasDotDot(inside) || strings.ContainsRune(inside, 0) {
		return nil, false
	}
	c := filepath.Clean(inside)
	proj := f.Project.Dst
	if c == proj || !within(c, proj) {
		return nil, false
	}
	for _, b := range f.Binds {
		if b.Dst != proj && within(b.Dst, proj) && within(c, b.Dst) {
			return nil, false
		}
	}
	rest := strings.TrimPrefix(c, strings.TrimSuffix(proj, "/")+"/")
	parts := strings.Split(rest, "/")
	for _, p := range parts {
		if p == "" || p == "." || p == ".." {
			return nil, false
		}
	}
	return parts, true
}

// lazyMatch: whether rel is a folder boxd may make mid-chat (the lazy rules: `dir` in a folder no
// deeper than Depth, not under a skipped or hidden one); returns how deep the rule's folder is and
// its markers (plain file names; one must be a file there).
func lazyMatch(rel []string, f shadowsFile) (int, []string, bool) {
	skip := map[string]bool{}
	for _, d := range f.SkipDirs {
		skip[d] = true
	}
	depth := f.Depth
	if depth <= 0 {
		depth = defaultLazyDepth
	}
	for _, rule := range f.Lazy {
		dir := filepath.Clean(rule.Dir)
		if dir == "." || filepath.IsAbs(dir) || hasDotDot(dir) {
			continue
		}
		dirParts := strings.Split(dir, "/")
		if len(rel) < len(dirParts) {
			continue
		}
		base := len(rel) - len(dirParts)
		if strings.Join(rel[base:], "/") != dir || base > depth {
			continue
		}
		ok := true
		for _, p := range rel[:base] {
			if strings.HasPrefix(p, ".") || skip[p] {
				ok = false
				break
			}
		}
		if !ok {
			continue
		}
		var markers []string
		for _, m := range rule.WhenAny {
			if m != "" && !strings.ContainsAny(m, "/@*?[") && m != "." && m != ".." {
				markers = append(markers, m)
			}
		}
		if len(markers) > 0 {
			return base, markers, true
		}
	}
	return 0, nil, false
}

type removal int

const (
	removedDir removal = iota // removed (or already gone)
	keptDir                   // a folder that could not be removed (not empty): try again later
	refusedDir                // not an empty real folder in the project (a link, a file, a link on the way, no marker)
)

const (
	atRemoveDir = 0x200    // AT_REMOVEDIR
	oPath       = 0x200000 // O_PATH
)

func rmdirAt(dirfd int, name string) error {
	p, err := syscall.BytePtrFromString(name)
	if err != nil {
		return err
	}
	_, _, e := syscall.Syscall(syscall.SYS_UNLINKAT, uintptr(dirfd), uintptr(unsafe.Pointer(p)), atRemoveDir)
	if e != 0 {
		return e
	}
	return nil
}

// statAt: the mode of name in dirfd, the name itself (a link is not followed).
func statAt(dirfd int, name string) (uint32, error) {
	fd, err := syscall.Openat(dirfd, name, oPath|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return 0, err
	}
	defer syscall.Close(fd)
	var st syscall.Stat_t
	if err := syscall.Fstat(fd, &st); err != nil {
		return 0, err
	}
	return st.Mode & syscall.S_IFMT, nil
}

// removeEmptyDir removes root/rel... if it is an empty real folder. Every folder on the way is
// opened from the project's real folder without following a link, so nothing outside it is
// reached; rmdir never removes a file or a link and fails on a folder with anything in it.
// markers (when given): one must be a regular file in the folder markerAt components down.
func removeEmptyDir(root string, rel []string, markerAt int, markers []string) removal {
	if len(rel) == 0 {
		return refusedDir
	}
	real, err := filepath.EvalSymlinks(root)
	if err != nil {
		if os.IsNotExist(err) {
			return removedDir
		}
		return keptDir
	}
	fd, err := syscall.Open(real, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return keptDir
	}
	for i := 0; ; i++ {
		if markers != nil && i == markerAt {
			found := false
			for _, m := range markers {
				if mode, err := statAt(fd, m); err == nil && mode == syscall.S_IFREG {
					found = true
					break
				}
			}
			if !found {
				syscall.Close(fd)
				return refusedDir
			}
		}
		name := rel[i]
		if i == len(rel)-1 {
			defer syscall.Close(fd)
			mode, err := statAt(fd, name)
			if err == syscall.ENOENT {
				return removedDir
			}
			if err != nil {
				return keptDir
			}
			if mode != syscall.S_IFDIR {
				return refusedDir
			}
			switch err := rmdirAt(fd, name); err {
			case nil, syscall.ENOENT:
				return removedDir
			case syscall.ENOTDIR:
				return refusedDir
			default:
				return keptDir
			}
		}
		next, err := syscall.Openat(fd, name, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		syscall.Close(fd)
		switch err {
		case nil:
			fd = next
		case syscall.ENOENT:
			return removedDir
		case syscall.ELOOP, syscall.ENOTDIR:
			return refusedDir
		default:
			return keptDir
		}
	}
}

// readBoxMadeFile reads the store's .made.json (box-written: a link is not followed, the size is capped).
func readBoxMadeFile(store string) []string {
	fh, err := os.OpenFile(filepath.Join(store, madeFileName), os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil
	}
	defer fh.Close()
	if fi, err := fh.Stat(); err != nil || !fi.Mode().IsRegular() {
		return nil
	}
	data, err := io.ReadAll(io.LimitReader(fh, 1<<20))
	if err != nil {
		return nil
	}
	var list []string
	if json.Unmarshal(data, &list) != nil {
		return nil
	}
	return list
}

// readInitMade: the mount points init made at the last start (<box>/init.json, written by init
// before the root switch), in case `up` did not get to record them.
func readInitMade(box string) []string {
	var info struct {
		Made []string `json:"made"`
	}
	if data, err := os.ReadFile(filepath.Join(box, "init.json")); err == nil {
		_ = json.Unmarshal(data, &info)
	}
	return info.Made
}

// removeShadowMade removes the mount points this box made on the host (empty folders only:
// anything written there since stays), after the box stopped without boxd's own clean-up.
func removeShadowMade(box string) {
	f, ok := readShadowsFile(box)
	if !ok || f.Project == nil {
		return
	}
	trusted := union(f.Made, readInitMade(box))
	isTrusted := map[string]bool{}
	var left []string
	for _, inside := range trusted {
		isTrusted[inside] = true
		rel, ok := projectRel(inside, f)
		if !ok {
			continue
		}
		if removeEmptyDir(f.Project.Src, rel, 0, nil) == keptDir {
			left = append(left, inside)
		}
	}
	start := map[string]bool{}
	for _, s := range f.Shadows {
		start[s] = true
	}
	// boxd's mid-chat ones: the list is the box's, so only what the lazy rules allow.
	for _, inside := range readBoxMadeFile(f.Store) {
		if isTrusted[inside] {
			continue
		}
		rel, ok := projectRel(inside, f)
		if !ok || start[filepath.Clean(inside)] {
			continue
		}
		at, markers, ok := lazyMatch(rel, f)
		if !ok {
			continue
		}
		_ = removeEmptyDir(f.Project.Src, rel, at, markers)
	}
	_ = os.Remove(filepath.Join(f.Store, madeFileName))
	f.Made = left
	_ = writeJSONFile(filepath.Join(box, "shadows.json"), f)
}
