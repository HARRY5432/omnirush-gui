//go:build !windows

package main

import (
	"os"
	"os/signal"
	"syscall"
)

func notifySignals(c chan os.Signal) {
	signal.Notify(c, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP, syscall.SIGQUIT)
}

func signalName(s os.Signal) string {
	switch s {
	case syscall.SIGINT:
		return "INT"
	case syscall.SIGHUP:
		return "HUP"
	case syscall.SIGQUIT:
		return "QUIT"
	default:
		return "TERM"
	}
}
