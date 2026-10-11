//go:build windows

package main

import (
	"os"
	"os/signal"
)

func notifySignals(c chan os.Signal) {
	signal.Notify(c, os.Interrupt)
}

func signalName(os.Signal) string { return "TERM" }
