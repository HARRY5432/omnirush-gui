package main

import (
	"reflect"
	"runtime"
	"testing"
)

func TestParseShellArgs(t *testing.T) {
	cases := []struct {
		in    []string
		cmd   string
		rest  []string
		login bool
		ok    bool
	}{
		{[]string{"-c", "ls -la"}, "ls -la", []string{}, false, true},
		{[]string{"-lc", "cygpath -w -- \"$1\"", "_", "/x"}, "cygpath -w -- \"$1\"", []string{"_", "/x"}, true, true},
		{[]string{"-l", "-c", "echo hi"}, "echo hi", []string{}, true, true},
		{[]string{}, "", nil, false, false},
		{[]string{"script.sh"}, "", nil, false, false},
		{[]string{"-c"}, "", nil, false, false},
		{[]string{"-ec", "x"}, "", nil, false, false},
	}
	for _, c := range cases {
		cmd, rest, login, ok := parseShellArgs(c.in)
		if ok != c.ok || cmd != c.cmd || login != c.login || (c.ok && !reflect.DeepEqual(rest, c.rest)) {
			t.Errorf("%v: got %q %v %v %v", c.in, cmd, rest, login, ok)
		}
	}
}

func TestMapPathSame(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip()
	}
	rec := &Record{Root: "/home/u/proj", CRoot: "/home/u/proj"}
	if got := mapPath("/home/u/proj/src", rec); got != "/home/u/proj/src" {
		t.Fatal(got)
	}
	rec = &Record{Root: "/home/u/proj", CRoot: "/app"}
	for in, want := range map[string]string{"/home/u/proj": "/app", "/home/u/proj/a/b": "/app/a/b", "/home/u/projx": "/home/u/projx", "/tmp": "/tmp", "": "/app"} {
		if got := mapPath(in, rec); got != want {
			t.Errorf("%q -> %q want %q", in, got, want)
		}
	}
	if got := unmapPath("/app/a/b", rec); got != "/home/u/proj/a/b" {
		t.Fatal(got)
	}
}

func TestForwardEnv(t *testing.T) {
	t.Setenv("OMNIRUSH_BOX_PASS_ENV", "MY_FLAG")
	got := forwardEnv([]string{"TERM=xterm", "OMNIRUSH_ACCESS_TOKEN=secret", "OPENAI_API_KEY=k", "PATH=/x", "HOME=/h", "OMNIRUSH_TURN=3", "MY_FLAG=1", "AWS_SECRET_ACCESS_KEY=s"})
	want := map[string]string{"TERM": "xterm", "OMNIRUSH_TURN": "3", "MY_FLAG": "1"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%v", got)
	}
}
