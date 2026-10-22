//go:build linux

// Ports the box listens on, and TCP streams to them, for backends whose box
// has its own network (Docker, Podman): the launcher opens the same port on
// this machine's 127.0.0.1 and carries each connection through boxd, so a
// dev server the agent starts in the box answers in the user's browser.
//
//	op "ports":   one Data frame, the JSON list of listening TCP sockets
//	              (/proc/net/tcp and tcp6), boxd's own port left out
//	op "connect": dial Port inside the box; on success one Data frame
//	              {"ok":true}, then raw bytes both ways until either side
//	              closes; on failure a Fail frame and an Exit frame
package main

import (
	"bufio"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"omnirush.ai/box/proto"
)

// ownPort is the port boxd listens on (never forwarded).
var ownPort atomic.Int64

// procNetFiles are read for listeners (a missing one, no IPv6, is skipped).
var procNetFiles = []string{"/proc/net/tcp", "/proc/net/tcp6"}

// tcpListen is the socket state LISTEN in /proc/net/tcp.
const tcpListen = "0A"

// listeners lists the box's listening TCP sockets, one per port (the widest
// address when a port is bound more than once), sorted by port.
func listeners() []proto.Listener {
	byPort := map[int]proto.Listener{}
	for _, file := range procNetFiles {
		f, err := os.Open(file)
		if err != nil {
			continue
		}
		for _, l := range parseProcNet(f) {
			if int64(l.Port) == ownPort.Load() {
				continue
			}
			if old, ok := byPort[l.Port]; !ok || addrRank(l.Addr) < addrRank(old.Addr) {
				byPort[l.Port] = l
			}
		}
		f.Close()
	}
	out := make([]proto.Listener, 0, len(byPort))
	for _, l := range byPort {
		out = append(out, l)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Port < out[j].Port })
	return out
}

// addrRank: any-address first, then loopback, then the rest.
func addrRank(addr string) int {
	ip := net.ParseIP(addr)
	switch {
	case ip == nil:
		return 3
	case ip.IsUnspecified():
		return 0
	case ip.IsLoopback():
		return 1
	default:
		return 2
	}
}

// parseProcNet reads the LISTEN rows of /proc/net/tcp or tcp6.
func parseProcNet(r io.Reader) []proto.Listener {
	var out []proto.Listener
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	first := true
	for sc.Scan() {
		if first {
			first = false // the header row
			continue
		}
		fields := strings.Fields(sc.Text())
		if len(fields) < 4 || fields[3] != tcpListen {
			continue
		}
		host, portHex, ok := strings.Cut(fields[1], ":")
		if !ok {
			continue
		}
		port, err := strconv.ParseUint(portHex, 16, 16)
		if err != nil || port == 0 {
			continue
		}
		ip, err := procIP(host)
		if err != nil {
			continue
		}
		out = append(out, proto.Listener{Port: int(port), Addr: ip.String()})
	}
	return out
}

// procIP decodes /proc/net's address: 32-bit words in host (little-endian) order.
func procIP(text string) (net.IP, error) {
	raw, err := hex.DecodeString(text)
	if err != nil || (len(raw) != 4 && len(raw) != 16) {
		return nil, errors.New("bad address")
	}
	ip := make(net.IP, len(raw))
	for w := 0; w < len(raw); w += 4 {
		ip[w], ip[w+1], ip[w+2], ip[w+3] = raw[w+3], raw[w+2], raw[w+1], raw[w]
	}
	if v4 := ip.To4(); v4 != nil {
		return v4, nil
	}
	return ip, nil
}

// dialTargets are the addresses inside the box a connect to `port` tries, in order.
func dialTargets(port int, ls []proto.Listener) []string {
	seen := map[string]bool{}
	var out []string
	add := func(host string) {
		addr := net.JoinHostPort(host, strconv.Itoa(port))
		if !seen[addr] {
			seen[addr] = true
			out = append(out, addr)
		}
	}
	for _, l := range ls {
		if l.Port != port {
			continue
		}
		ip := net.ParseIP(l.Addr)
		switch {
		case ip == nil:
		case ip.IsUnspecified() && ip.To4() != nil:
			add("127.0.0.1")
		case ip.IsUnspecified():
			add("127.0.0.1")
			add("::1")
		default:
			add(ip.String())
		}
	}
	add("127.0.0.1")
	add("::1")
	return out
}

// connectPort dials the port inside the box and joins it to the client's connection.
func connectPort(c *conn, req proto.Request, start time.Time) {
	if req.Port <= 0 || req.Port > 65535 {
		c.fail(start, fmt.Errorf("bad port %d", req.Port))
		return
	}
	if int64(req.Port) == ownPort.Load() {
		c.fail(start, errors.New("that is the sandbox helper's own port"))
		return
	}
	var target net.Conn
	var lastErr error
	for _, addr := range dialTargets(req.Port, listeners()) {
		target, lastErr = net.DialTimeout("tcp", addr, 3*time.Second)
		if lastErr == nil {
			break
		}
	}
	if target == nil {
		c.fail(start, fmt.Errorf("nothing answers on port %d in the sandbox: %v", req.Port, lastErr))
		return
	}
	defer target.Close()
	if tcp, ok := target.(*net.TCPConn); ok {
		_ = tcp.SetNoDelay(true)
	}
	ok, _ := json.Marshal(map[string]any{"ok": true})
	if err := c.frame(proto.Data, ok); err != nil {
		return
	}
	pipeBoth(c, target)
}

// pipeBoth copies both ways; a side that ends its writes half-closes the
// other, and the stream is over when both directions are.
func pipeBoth(c *conn, target net.Conn) {
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		// c.r first: bytes the client sent right after its request line are buffered there.
		if _, err := io.Copy(target, c.r); err != nil {
			_ = target.Close()
			_ = c.Conn.Close()
			return
		}
		closeWrite(target)
	}()
	go func() {
		defer wg.Done()
		if _, err := io.Copy(c.Conn, target); err != nil {
			_ = target.Close()
			_ = c.Conn.Close()
			return
		}
		closeWrite(c.Conn)
	}()
	wg.Wait()
}

func closeWrite(c net.Conn) {
	if tcp, ok := c.(*net.TCPConn); ok {
		_ = tcp.CloseWrite()
		return
	}
	_ = c.Close()
}
