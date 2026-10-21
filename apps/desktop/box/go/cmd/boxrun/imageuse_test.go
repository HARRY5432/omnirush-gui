//go:build linux

package main

import (
	"os"
	"path/filepath"
	"testing"
)

func unpacked(t *testing.T, store, id string) string {
	t.Helper()
	dir := filepath.Join(store, "images", id)
	if err := os.MkdirAll(filepath.Join(dir, "rootfs", "usr"), 0o755); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(dir, "image.json"), []byte(`{"ref":"ghcr.io/omnirush-ai/box-base@sha256:x"}`), 0o644)
	return dir
}

func TestRmImageRefusesWhileABoxUsesIt(t *testing.T) {
	root := t.TempDir()
	store, boxes := filepath.Join(root, "store"), filepath.Join(root, "boxes")
	img1, img2 := unpacked(t, store, "img1-amd64"), unpacked(t, store, "img2-amd64")
	boxA := filepath.Join(boxes, "a")
	// A stopped box (no state.json): only its folder and its record of the image.
	if err := recordImageUse(store, boxA, "img1-amd64"); err != nil {
		t.Fatal(err)
	}
	if err := cmdRmImage([]string{"--store", store, "--id", "img1-amd64"}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(img1); err != nil {
		t.Fatal("deleted the image a stopped box still runs on")
	}
	if got := imageUsers(store, "img1-amd64", nil); len(got) != 1 || got[0] != boxA {
		t.Fatalf("users %v", got)
	}

	// A box found only under --boxes (no registration in the store) also keeps its image.
	boxB := filepath.Join(boxes, "b")
	os.MkdirAll(boxB, 0o755)
	os.WriteFile(filepath.Join(boxB, boxImageFile), []byte("img2-amd64\n"), 0o644)
	cmdRmImage([]string{"--store", store, "--id", "img2-amd64", "--boxes", boxes})
	if _, err := os.Stat(img2); err != nil {
		t.Fatal("deleted the image of a box under --boxes")
	}

	// The box moves to another image: the old one is free again.
	unpacked(t, store, "img3-amd64")
	if err := recordImageUse(store, boxA, "img3-amd64"); err != nil {
		t.Fatal(err)
	}
	if err := cmdRmImage([]string{"--store", store, "--id", "img1-amd64"}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(img1); !os.IsNotExist(err) {
		t.Fatal("an image no box uses was kept")
	}

	// The box is removed (`boxrun rm`): its registration is stale and the image goes.
	os.RemoveAll(boxA)
	if err := cmdRmImage([]string{"--store", store, "--id", "img3-amd64"}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(store, "images", "img3-amd64")); !os.IsNotExist(err) {
		t.Fatal("the image of a removed box was kept")
	}
	if _, err := os.Stat(refsDir(store, "img3-amd64")); !os.IsNotExist(err) {
		t.Fatal("refs left behind")
	}
	if err := cmdRmImage([]string{"--store", store, "--id", "../x"}); err == nil {
		t.Fatal("a path as an id was accepted")
	}
}
