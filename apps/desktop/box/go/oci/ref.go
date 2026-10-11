// Package oci pulls a pinned OCI/Docker image from a registry (anonymous or
// with a token) and unpacks its layers into one root folder, with no daemon
// and no root: what the bubblewrap box (and the WSL distro's boxes) start
// from. Only what the box images use is supported: gzip or plain tar layers,
// image indexes and manifest lists, schema-2 manifests.
package oci

import (
	"errors"
	"fmt"
	"strings"
)

// Ref is a parsed image reference.
type Ref struct {
	Registry string // host[:port] as the API is reached (registry-1.docker.io for Docker Hub)
	Repo     string // library/ubuntu, omnirush-ai/box-base
	Tag      string
	Digest   string // sha256:..., when pinned
}

// String is the reference as written (registry/repo[:tag][@digest]).
func (r Ref) String() string {
	host := r.Registry
	if host == "registry-1.docker.io" {
		host = "docker.io"
	}
	s := host + "/" + r.Repo
	if r.Tag != "" {
		s += ":" + r.Tag
	}
	if r.Digest != "" {
		s += "@" + r.Digest
	}
	return s
}

// Reference is what the manifest is fetched by: the digest when pinned.
func (r Ref) Reference() string {
	if r.Digest != "" {
		return r.Digest
	}
	if r.Tag != "" {
		return r.Tag
	}
	return "latest"
}

// Plain reports whether the registry is reached over plain HTTP: loopback
// only (a local registry for tests), as Docker does by default.
func (r Ref) Plain() bool {
	host := r.Registry
	if i := strings.LastIndex(host, ":"); i > 0 && !strings.HasSuffix(host, "]") {
		host = host[:i]
	}
	return host == "localhost" || host == "127.0.0.1" || host == "[::1]"
}

// ParseRef reads docker-style references: ubuntu, ubuntu:24.04,
// ghcr.io/omnirush-ai/box-base:2026.10.1@sha256:..., localhost:5000/x/y.
func ParseRef(s string) (Ref, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return Ref{}, errors.New("empty image reference")
	}
	var r Ref
	if i := strings.Index(s, "@"); i >= 0 {
		r.Digest = s[i+1:]
		s = s[:i]
		if !ValidDigest(r.Digest) {
			return Ref{}, fmt.Errorf("bad digest %q", r.Digest)
		}
	}
	first := s
	rest := ""
	if i := strings.Index(s, "/"); i >= 0 {
		first, rest = s[:i], s[i+1:]
	}
	if rest != "" && (strings.ContainsAny(first, ".:") || first == "localhost") {
		r.Registry = first
		s = rest
	} else {
		r.Registry = "registry-1.docker.io"
	}
	if r.Registry == "docker.io" || r.Registry == "index.docker.io" {
		r.Registry = "registry-1.docker.io"
	}
	if i := strings.LastIndex(s, ":"); i >= 0 && !strings.Contains(s[i:], "/") {
		r.Tag = s[i+1:]
		s = s[:i]
	}
	if r.Registry == "registry-1.docker.io" && !strings.Contains(s, "/") {
		s = "library/" + s
	}
	if s == "" || strings.ContainsAny(s, " \t@") || s != strings.ToLower(s) {
		return Ref{}, fmt.Errorf("bad repository %q", s)
	}
	r.Repo = s
	if r.Tag == "" && r.Digest == "" {
		r.Tag = "latest"
	}
	return r, nil
}

// ValidDigest reports a sha256 digest (the only algorithm the boxes use).
func ValidDigest(d string) bool {
	if !strings.HasPrefix(d, "sha256:") || len(d) != 71 {
		return false
	}
	for _, c := range d[7:] {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}
