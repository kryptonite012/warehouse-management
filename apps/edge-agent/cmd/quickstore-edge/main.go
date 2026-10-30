package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/kryptonite012/warehouse-management/apps/edge-agent/internal/agent"
)

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func main() {
	interval, err := time.ParseDuration(env("EDGE_SYNC_INTERVAL", "15s"))
	if err != nil {
		slog.Error("bad EDGE_SYNC_INTERVAL", "err", err)
		os.Exit(2)
	}
	token := os.Getenv("EDGE_DEVICE_TOKEN")
	if token == "" {
		slog.Error("EDGE_DEVICE_TOKEN is required (register the device via POST /api/v1/sync/devices)")
		os.Exit(2)
	}
	a, err := agent.New(agent.Config{
		CentralURL:   env("EDGE_CENTRAL_URL", "http://localhost:3000/api/v1"),
		DeviceToken:  token,
		DataDir:      env("EDGE_DATA_DIR", "./data"),
		SyncInterval: interval,
	})
	if err != nil {
		slog.Error("cannot open journal", "err", err)
		os.Exit(1)
	}
	defer a.Close()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go a.Run(ctx)

	srv := &http.Server{Addr: env("EDGE_LISTEN", ":8090"), Handler: a.Handler(), ReadHeaderTimeout: 5 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
	}()
	slog.Info("edge agent listening", "addr", srv.Addr)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		slog.Error("server failed", "err", err)
		os.Exit(1)
	}
}
