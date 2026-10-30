// Package agent runs the dark-store edge service: a LAN API for scanners and
// tablets that keeps working without the central server, plus a sync loop that
// drains the local journal to central when connectivity returns.
package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/kryptonite012/warehouse-management/apps/edge-agent/internal/journal"
)

type Config struct {
	CentralURL   string // e.g. https://quickstore.internal/api/v1
	DeviceToken  string
	DataDir      string
	SyncInterval time.Duration
	HTTPClient   *http.Client
}

type Snapshot struct {
	ServerTime        string           `json:"serverTime"`
	WarehouseID       string           `json:"warehouseId"`
	AllowedOps        []string         `json:"allowedOps"`
	InventoryAdvisory bool             `json:"inventoryIsAdvisory"`
	Skus              []SnapshotSku    `json:"skus"`
	Balances          []map[string]any `json:"balances"`
	PickingTasks      []map[string]any `json:"pickingTasks"`
	OpenCounts        []map[string]any `json:"openCounts"`
	InboundTransfers  []map[string]any `json:"inboundTransfers"`
}

type SnapshotSku struct {
	ID       string   `json:"id"`
	Code     string   `json:"code"`
	Name     string   `json:"name"`
	Barcodes []string `json:"barcodes"`
}

type Agent struct {
	cfg      Config
	journal  *journal.Journal
	mu       sync.RWMutex
	snapshot *Snapshot
	online   bool
	lastSync time.Time
	lastErr  string
}

func New(cfg Config) (*Agent, error) {
	if cfg.HTTPClient == nil {
		cfg.HTTPClient = &http.Client{Timeout: 10 * time.Second}
	}
	if cfg.SyncInterval == 0 {
		cfg.SyncInterval = 15 * time.Second
	}
	j, err := journal.Open(cfg.DataDir)
	if err != nil {
		return nil, err
	}
	a := &Agent{cfg: cfg, journal: j}
	a.loadCachedSnapshot()
	return a, nil
}

func (a *Agent) Close() error { return a.journal.Close() }

// ------------------------------------------------------------------ sync

// SyncOnce refreshes the snapshot and pushes pending ops. Safe to call repeatedly.
func (a *Agent) SyncOnce(ctx context.Context) error {
	err := a.syncOnce(ctx)
	a.mu.Lock()
	defer a.mu.Unlock()
	a.online = err == nil
	if err != nil {
		a.lastErr = err.Error()
	} else {
		a.lastErr = ""
		a.lastSync = time.Now().UTC()
	}
	return err
}

func (a *Agent) syncOnce(ctx context.Context) error {
	for {
		pending := a.journal.Pending(200)
		if len(pending) == 0 {
			break
		}
		var resp struct {
			Results []struct {
				ClientOpID string `json:"clientOpId"`
				Status     string `json:"status"`
				Message    string `json:"message"`
			} `json:"results"`
		}
		if err := a.call(ctx, http.MethodPost, "/sync/push", map[string]any{"operations": pending}, &resp); err != nil {
			return err
		}
		acks := make([]journal.Ack, 0, len(resp.Results))
		for _, r := range resp.Results {
			if r.Status == "PROCESSING" {
				continue // still in flight on central; retry next round
			}
			acks = append(acks, journal.Ack{ClientOpID: r.ClientOpID, Status: r.Status, Message: r.Message})
		}
		if err := a.journal.Acknowledge(acks); err != nil {
			return err
		}
		if len(acks) == 0 {
			break
		}
	}
	var snap Snapshot
	if err := a.call(ctx, http.MethodGet, "/sync/snapshot", nil, &snap); err != nil {
		return err
	}
	a.mu.Lock()
	a.snapshot = &snap
	a.mu.Unlock()
	return a.persistSnapshot(&snap)
}

func (a *Agent) Run(ctx context.Context) {
	t := time.NewTicker(a.cfg.SyncInterval)
	defer t.Stop()
	for {
		if err := a.SyncOnce(ctx); err != nil {
			slog.Warn("sync failed; operating offline", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (a *Agent) call(ctx context.Context, method, path string, body, out any) error {
	var rdr *bytes.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rdr = bytes.NewReader(b)
	} else {
		rdr = bytes.NewReader(nil)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(a.cfg.CentralURL, "/")+path, rdr)
	if err != nil {
		return err
	}
	req.Header.Set("x-device-token", a.cfg.DeviceToken)
	req.Header.Set("content-type", "application/json")
	res, err := a.cfg.HTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		return fmt.Errorf("central %s %s: HTTP %d", method, path, res.StatusCode)
	}
	return json.NewDecoder(res.Body).Decode(out)
}

func (a *Agent) persistSnapshot(s *Snapshot) error {
	b, err := json.Marshal(s)
	if err != nil {
		return err
	}
	tmp := filepath.Join(a.cfg.DataDir, "snapshot.json.tmp")
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(a.cfg.DataDir, "snapshot.json"))
}

func (a *Agent) loadCachedSnapshot() {
	b, err := os.ReadFile(filepath.Join(a.cfg.DataDir, "snapshot.json"))
	if err != nil {
		return
	}
	var s Snapshot
	if json.Unmarshal(b, &s) == nil {
		a.snapshot = &s
	}
}

// ------------------------------------------------------------- local API

var opRoutes = map[string]string{
	"/ops/pick-scan":        "PICK_SCAN",
	"/ops/damage":           "DAMAGE_REPORT",
	"/ops/count":            "COUNT_SUBMIT",
	"/ops/transfer-receive": "TRANSFER_RECEIVE",
}

var ErrNotPermitted = errors.New("operation not permitted on this device")

// Record validates and journals an operation. It works identically online and offline.
func (a *Agent) Record(opType, performedBy string, payload map[string]any) (journal.Op, error) {
	a.mu.RLock()
	snap := a.snapshot
	a.mu.RUnlock()
	if snap == nil {
		return journal.Op{}, errors.New("device has never synced; connect once to receive its configuration")
	}
	if !slices.Contains(snap.AllowedOps, opType) {
		return journal.Op{}, ErrNotPermitted
	}
	if performedBy == "" {
		return journal.Op{}, errors.New("performedBy is required")
	}
	return a.journal.Append(opType, performedBy, payload)
}

func (a *Agent) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /status", func(w http.ResponseWriter, _ *http.Request) {
		total, pending, conflicts := a.journal.Stats()
		a.mu.RLock()
		defer a.mu.RUnlock()
		var allowed []string
		if a.snapshot != nil {
			allowed = a.snapshot.AllowedOps
		}
		writeJSON(w, 200, map[string]any{
			"online": a.online, "lastSyncAt": a.lastSync, "lastError": a.lastErr,
			"journal":    map[string]any{"total": total, "pending": pending, "needsReview": conflicts},
			"allowedOps": allowed,
			// While offline, stock figures are the last snapshot minus nothing: advisory only.
			"inventoryAccuracy": map[bool]string{true: "live", false: "advisory (offline)"}[a.online],
		})
	})
	mux.HandleFunc("GET /lookup/{barcode}", func(w http.ResponseWriter, r *http.Request) {
		a.mu.RLock()
		defer a.mu.RUnlock()
		if a.snapshot == nil {
			writeJSON(w, 503, map[string]string{"error": "no local catalog yet"})
			return
		}
		code := r.PathValue("barcode")
		for _, s := range a.snapshot.Skus {
			if slices.Contains(s.Barcodes, code) {
				writeJSON(w, 200, s)
				return
			}
		}
		writeJSON(w, 404, map[string]string{"error": "unknown barcode"})
	})
	for path, opType := range opRoutes {
		mux.HandleFunc("POST "+path, func(w http.ResponseWriter, r *http.Request) {
			var body struct {
				PerformedBy string         `json:"performedBy"`
				Payload     map[string]any `json:"payload"`
			}
			if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&body); err != nil {
				writeJSON(w, 400, map[string]string{"error": "invalid JSON"})
				return
			}
			op, err := a.Record(opType, body.PerformedBy, body.Payload)
			switch {
			case errors.Is(err, ErrNotPermitted):
				writeJSON(w, 403, map[string]string{"error": err.Error()})
			case err != nil:
				writeJSON(w, 422, map[string]string{"error": err.Error()})
			default:
				writeJSON(w, 202, map[string]any{"queued": true, "clientOpId": op.ClientOpID, "sequence": op.Sequence})
			}
		})
	}
	return mux
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
