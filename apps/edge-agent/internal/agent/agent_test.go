package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
)

// fakeCentral mimics the central sync API: dedupes by clientOpId and can be taken offline.
type fakeCentral struct {
	mu      sync.Mutex
	applied map[string]int
	offline atomic.Bool
}

func (f *fakeCentral) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /sync/snapshot", func(w http.ResponseWriter, r *http.Request) {
		if f.offline.Load() {
			http.Error(w, "down", 503)
			return
		}
		_ = json.NewEncoder(w).Encode(Snapshot{
			WarehouseID: "store-1", AllowedOps: []string{"DAMAGE_REPORT", "PICK_SCAN"}, InventoryAdvisory: true,
			Skus: []SnapshotSku{{ID: "sku-1", Code: "MILK-500", Name: "Milk", Barcodes: []string{"8900000000011"}}},
		})
	})
	mux.HandleFunc("POST /sync/push", func(w http.ResponseWriter, r *http.Request) {
		if f.offline.Load() {
			http.Error(w, "down", 503)
			return
		}
		var body struct {
			Operations []struct {
				ClientOpID string `json:"clientOpId"`
			} `json:"operations"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.mu.Lock()
		defer f.mu.Unlock()
		results := []map[string]any{}
		for _, op := range body.Operations {
			f.applied[op.ClientOpID]++
			results = append(results, map[string]any{"clientOpId": op.ClientOpID, "status": "APPLIED"})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"results": results})
	})
	return mux
}

func newAgent(t *testing.T, url, dir string) *Agent {
	t.Helper()
	a, err := New(Config{CentralURL: url, DeviceToken: "tok", DataDir: dir})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = a.Close() })
	return a
}

func post(t *testing.T, h http.Handler, path string, body any) *httptest.ResponseRecorder {
	b, _ := json.Marshal(body)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, path, bytes.NewReader(b)))
	return rec
}

// TEST 3 + TEST 4: offline operations keep working, then sync exactly once after reconnect
// even if the agent restarts in between.
func TestOfflineThenReconnect(t *testing.T) {
	central := &fakeCentral{applied: map[string]int{}}
	srv := httptest.NewServer(central.handler())
	defer srv.Close()
	dir := t.TempDir()

	a := newAgent(t, srv.URL, dir)
	if err := a.SyncOnce(context.Background()); err != nil {
		t.Fatalf("initial sync: %v", err)
	}

	central.offline.Store(true)
	h := a.Handler()
	for i := 0; i < 3; i++ {
		rec := post(t, h, "/ops/damage", map[string]any{"performedBy": "user-1", "payload": map[string]any{"batchId": "b1", "quantity": 1}})
		if rec.Code != 202 {
			t.Fatalf("offline damage report should be queued, got %d %s", rec.Code, rec.Body)
		}
	}
	if err := a.SyncOnce(context.Background()); err == nil {
		t.Fatal("expected sync to fail while central is offline")
	}
	// Barcode lookup works from the local cache while offline.
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/lookup/8900000000011", nil))
	if rec.Code != 200 {
		t.Fatalf("offline lookup: %d", rec.Code)
	}
	// Ops not allowed for this device are refused locally.
	if rec := post(t, h, "/ops/count", map[string]any{"performedBy": "user-1", "payload": map[string]any{}}); rec.Code != 403 {
		t.Fatalf("COUNT_SUBMIT should be forbidden, got %d", rec.Code)
	}

	// Simulate a crash/restart while still offline: journal must survive.
	_ = a.Close()
	a2 := newAgent(t, srv.URL, dir)
	if _, pending, _ := a2.journal.Stats(); pending != 3 {
		t.Fatalf("expected 3 pending after restart, got %d", pending)
	}

	central.offline.Store(false)
	for i := 0; i < 3; i++ { // repeated syncs must not re-send acknowledged ops
		if err := a2.SyncOnce(context.Background()); err != nil {
			t.Fatalf("sync after reconnect: %v", err)
		}
	}
	central.mu.Lock()
	defer central.mu.Unlock()
	if len(central.applied) != 3 {
		t.Fatalf("expected 3 distinct ops at central, got %d", len(central.applied))
	}
	for id, n := range central.applied {
		if n != 1 {
			t.Fatalf("op %s delivered %d times", id, n)
		}
	}
	if _, pending, _ := a2.journal.Stats(); pending != 0 {
		t.Fatalf("expected empty queue, got %d", pending)
	}
}

func TestNeverSyncedDeviceRefusesOps(t *testing.T) {
	a := newAgent(t, "http://127.0.0.1:1", t.TempDir())
	if _, err := a.Record("DAMAGE_REPORT", "u", nil); err == nil {
		t.Fatal("expected refusal before first sync")
	}
}
