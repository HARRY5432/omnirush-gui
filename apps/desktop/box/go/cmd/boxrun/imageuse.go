//go:build linux

package main

// Which boxes use which unpacked image, so `rmimage` never deletes the lower
// layer of a box that still exists (running or stopped). `up` records the
// image in <box>/image.id and registers the box in <store>/refs/<id>/; both
// happen under the image's store lock, the same lock `rmimage` holds while it
// checks and deletes.

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const boxImageFile = "image.id"

func refsDir(store, id string) string { return filepath.Join(store, "refs", id) }

func boxRefName(box string) string {
	sum := sha256.Sum256([]byte(box))
	return hex.EncodeToString(sum[:12])
}

// boxImage is the image id a box records, or "".
func boxImage(box string) string {
	data, err := os.ReadFile(filepath.Join(box, boxImageFile))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

// recordImageUse marks `box` as a user of image `id` (and no longer of the one it ran on before).
func recordImageUse(store, box, id string) error {
	if old := boxImage(box); old != "" && old != id && !strings.ContainsAny(old, "/\\.") {
		_ = os.Remove(filepath.Join(refsDir(store, old), boxRefName(box)))
	}
	if err := os.MkdirAll(box, 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(box, boxImageFile), []byte(id+"\n"), 0o644); err != nil {
		return err
	}
	if err := os.MkdirAll(refsDir(store, id), 0o700); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(refsDir(store, id), boxRefName(box)), []byte(box+"\n"), 0o600)
}

// imageUsers lists the boxes that still use image `id`: the ones registered
// in the store (a registration whose box is gone or now runs another image is
// dropped) and any box folder directly under one of `roots` recording it.
func imageUsers(store, id string, roots []string) []string {
	seen := map[string]bool{}
	var users []string
	add := func(box string) {
		if !seen[box] {
			seen[box] = true
			users = append(users, box)
		}
	}
	dir := refsDir(store, id)
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		file := filepath.Join(dir, e.Name())
		data, err := os.ReadFile(file)
		if err != nil {
			continue
		}
		box := strings.TrimSpace(string(data))
		if info, err := os.Stat(box); err == nil && info.IsDir() && boxImage(box) == id {
			add(box)
			continue
		}
		_ = os.Remove(file)
	}
	for _, root := range roots {
		if root == "" {
			continue
		}
		subs, _ := os.ReadDir(root)
		for _, s := range subs {
			if !s.IsDir() {
				continue
			}
			box := filepath.Join(root, s.Name())
			if boxImage(box) == id {
				add(box)
			}
		}
	}
	sort.Strings(users)
	return users
}
