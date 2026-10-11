package proto

import (
	"bufio"
	"bytes"
	"strings"
	"testing"
)

func TestFrames(t *testing.T) {
	var b bytes.Buffer
	big := bytes.Repeat([]byte("x"), MaxFrame+10)
	if err := WriteFrame(&b, Stdout, []byte("hi")); err != nil {
		t.Fatal(err)
	}
	if err := WriteFrame(&b, Data, big); err != nil {
		t.Fatal(err)
	}
	k, p, err := ReadFrame(&b, nil)
	if err != nil || k != Stdout || string(p) != "hi" {
		t.Fatal(k, p, err)
	}
	total := 0
	for total < len(big) {
		k, p, err = ReadFrame(&b, nil)
		if err != nil || k != Data {
			t.Fatal(err)
		}
		total += len(p)
	}
}

func TestRequestAuth(t *testing.T) {
	var b bytes.Buffer
	_ = WriteRequest(&b, Request{Op: "ping", Token: "t1"})
	if _, err := ReadRequest(bufio.NewReader(bytes.NewReader(b.Bytes())), "t2"); err == nil || !strings.Contains(err.Error(), "unauthorized") {
		t.Fatal("wrong token accepted")
	}
	req, err := ReadRequest(bufio.NewReader(bytes.NewReader(b.Bytes())), "t1")
	if err != nil || req.Op != "ping" {
		t.Fatal(err)
	}
	if _, err := ReadRequest(bufio.NewReader(strings.NewReader("{}\n")), ""); err == nil {
		t.Fatal("empty token accepted")
	}
}
