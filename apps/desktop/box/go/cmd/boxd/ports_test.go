//go:build linux

package main

import (
	"bufio"
	"encoding/json"
	"io"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"

	"omnirush.ai/box/proto"
)

const procTCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:2238 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1 0000000000000000 100 0 0 10 0
   1: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 2 1 0000000000000000 100 0 0 10 0
   2: 0100007F:1F90 0100007F:D2F0 01 00000000:00000000 00:00000000 00000000  1000        0 3 1 0000000000000000 20 4 30 10 -1
   3: 1600640A:1E61 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 4 1 0000000000000000 100 0 0 10 0
`

const procTCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000000000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5 1 0000000000000000 100 0 0 10 0
   1: 00000000000000000000000001000000:13BA 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 6 1 0000000000000000 100 0 0 10 0
   2: 0000000000000000FFFF00000100007F:0050 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 7 1 0000000000000000 100 0 0 10 0
`

func TestParseProcNet(t *testing.T) {
	got := parseProcNet(strings.NewReader(procTCP))
	want := []proto.Listener{{Port: 8760, Addr: "0.0.0.0"}, {Port: 8080, Addr: "127.0.0.1"}, {Port: 7777, Addr: "10.100.0.22"}}
	if len(got) != len(want) {
		t.Fatalf("%v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("%d: %v want %v", i, got[i], want[i])
		}
	}
	got6 := parseProcNet(strings.NewReader(procTCP6))
	want6 := []proto.Listener{{Port: 3000, Addr: "::"}, {Port: 5050, Addr: "::1"}, {Port: 80, Addr: "127.0.0.1"}}
	if len(got6) != len(want6) {
		t.Fatalf("%v", got6)
	}
	for i := range want6 {
		if got6[i] != want6[i] {
			t.Fatalf("%d: %v want %v", i, got6[i], want6[i])
		}
	}
}

func TestDialTargets(t *testing.T) {
	ls := []proto.Listener{{Port: 3000, Addr: "::"}, {Port: 5050, Addr: "::1"}, {Port: 9000, Addr: "10.1.2.3"}}
	if got := strings.Join(dialTargets(3000, ls), " "); got != "127.0.0.1:3000 [::1]:3000" {
		t.Fatal(got)
	}
	if got := strings.Join(dialTargets(5050, ls), " "); got != "[::1]:5050 127.0.0.1:5050" {
		t.Fatal(got)
	}
	if got := strings.Join(dialTargets(9000, ls), " "); got != "10.1.2.3:9000 127.0.0.1:9000 [::1]:9000" {
		t.Fatal(got)
	}
	if got := strings.Join(dialTargets(1, nil), " "); got != "127.0.0.1:1 [::1]:1" {
		t.Fatal(got)
	}
}

// An echo server that upper-cases, and closes after the client half-closes.
func upperServer(t *testing.T) (int, net.Listener) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				data, _ := io.ReadAll(c)
				_, _ = c.Write([]byte(strings.ToUpper(string(data))))
			}(c)
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port, ln
}

func TestPortsListsListener(t *testing.T) {
	_, addr := startDaemon(t)
	port, _ := upperServer(t)
	res := call(t, addr, proto.Request{Op: "ports"}, nil)
	var ls []proto.Listener
	if err := json.Unmarshal(res.data, &ls); err != nil {
		t.Fatal(err, string(res.data))
	}
	found := false
	for _, l := range ls {
		if l.Port == port && l.Addr == "127.0.0.1" {
			found = true
		}
	}
	if !found {
		t.Fatalf("port %d not in %v", port, ls)
	}
}

func TestConnectStreams(t *testing.T) {
	_, addr := startDaemon(t)
	port, _ := upperServer(t)
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	// The request and the first bytes in one write: boxd keeps what it buffered past the line.
	line, _ := json.Marshal(proto.Request{V: proto.Version, Token: "tok", Op: "connect", Port: port})
	if _, err := c.Write(append(append(line, '\n'), []byte("hello ")...)); err != nil {
		t.Fatal(err)
	}
	r := bufio.NewReader(c)
	k, p, err := proto.ReadFrame(r, nil)
	if err != nil || k != proto.Data || !strings.Contains(string(p), `"ok":true`) {
		t.Fatal(k, string(p), err)
	}
	_, _ = c.Write([]byte("box"))
	_ = c.(*net.TCPConn).CloseWrite()
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	got, err := io.ReadAll(r)
	if err != nil || string(got) != "HELLO BOX" {
		t.Fatalf("%q %v", got, err)
	}
}

func TestConnectNothingThere(t *testing.T) {
	_, addr := startDaemon(t)
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	res := call(t, addr, proto.Request{Op: "connect", Port: port}, nil)
	if res.exit.Code == 0 || !strings.Contains(res.err, "nothing answers") {
		t.Fatalf("%d %q", res.exit.Code, res.err)
	}
	res = call(t, addr, proto.Request{Op: "connect", Port: 0}, nil)
	if res.exit.Code == 0 || !strings.Contains(res.err, "bad port") {
		t.Fatalf("%d %q", res.exit.Code, res.err)
	}
}

func TestConnectNotOwnPort(t *testing.T) {
	_, addr := startDaemon(t)
	_, p, _ := net.SplitHostPort(addr)
	own, _ := strconv.Atoi(p)
	ownPort.Store(int64(own))
	t.Cleanup(func() { ownPort.Store(0) })
	res := call(t, addr, proto.Request{Op: "connect", Port: own}, nil)
	if res.exit.Code == 0 || !strings.Contains(res.err, "own port") {
		t.Fatalf("%d %q", res.exit.Code, res.err)
	}
	res = call(t, addr, proto.Request{Op: "ports"}, nil)
	if strings.Contains(string(res.data), `"port":`+p+`,`) {
		t.Fatalf("own port listed: %s", res.data)
	}
}
