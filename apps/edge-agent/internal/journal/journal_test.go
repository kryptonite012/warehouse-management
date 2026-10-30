package journal

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPersistsAndRecoversFromTornWrite(t *testing.T) {
	dir := t.TempDir()
	j, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	a, _ := j.Append("DAMAGE_REPORT", "u1", map[string]any{"q": 1})
	b, _ := j.Append("DAMAGE_REPORT", "u1", map[string]any{"q": 2})
	if err := j.Acknowledge([]Ack{{ClientOpID: a.ClientOpID, Status: "APPLIED"}}); err != nil {
		t.Fatal(err)
	}
	_ = j.Close()

	// Simulate power loss in the middle of writing a third record.
	f, _ := os.OpenFile(filepath.Join(dir, "ops.jsonl"), os.O_APPEND|os.O_WRONLY, 0o600)
	_, _ = f.WriteString(`{"clientOpId":"torn","seq`)
	_ = f.Close()

	j2, err := Open(dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer j2.Close()
	p := j2.Pending(10)
	if len(p) != 1 || p[0].ClientOpID != b.ClientOpID {
		t.Fatalf("expected only op b pending, got %+v", p)
	}
	c, _ := j2.Append("PICK_SCAN", "u2", nil)
	if c.Sequence != 3 {
		t.Fatalf("sequence must continue after restart, got %d", c.Sequence)
	}
}
