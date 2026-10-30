// Package journal is a durable, append-only operation log for offline store work.
//
// Two files live in the data directory:
//
//	ops.jsonl   every operation ever accepted locally (fsync'd before acknowledging)
//	acks.jsonl  client op ids confirmed by central (APPLIED, CONFLICT or REJECTED)
//
// Pending = ops - acks. Because each op carries a stable client id, replaying
// after a crash can never double-apply: central de-duplicates by that id.
package journal

import (
	"bufio"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type Op struct {
	ClientOpID  string         `json:"clientOpId"`
	Sequence    int64          `json:"sequence"`
	OpType      string         `json:"opType"`
	OccurredAt  time.Time      `json:"occurredAt"`
	PerformedBy string         `json:"performedBy"`
	Payload     map[string]any `json:"payload"`
}

type Ack struct {
	ClientOpID string    `json:"clientOpId"`
	Status     string    `json:"status"`
	Message    string    `json:"message,omitempty"`
	AckedAt    time.Time `json:"ackedAt"`
}

type Journal struct {
	mu      sync.Mutex
	dir     string
	ops     []Op
	acks    map[string]Ack
	nextSeq int64
	opsFile *os.File
	ackFile *os.File
}

func Open(dir string) (*Journal, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	j := &Journal{dir: dir, acks: map[string]Ack{}, nextSeq: 1}
	if err := readLines(filepath.Join(dir, "ops.jsonl"), func(b []byte) error {
		var op Op
		if err := json.Unmarshal(b, &op); err != nil {
			return err
		}
		j.ops = append(j.ops, op)
		if op.Sequence >= j.nextSeq {
			j.nextSeq = op.Sequence + 1
		}
		return nil
	}); err != nil {
		return nil, fmt.Errorf("read ops: %w", err)
	}
	if err := readLines(filepath.Join(dir, "acks.jsonl"), func(b []byte) error {
		var a Ack
		if err := json.Unmarshal(b, &a); err != nil {
			return err
		}
		j.acks[a.ClientOpID] = a
		return nil
	}); err != nil {
		return nil, fmt.Errorf("read acks: %w", err)
	}
	var err error
	if j.opsFile, err = os.OpenFile(filepath.Join(dir, "ops.jsonl"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600); err != nil {
		return nil, err
	}
	if j.ackFile, err = os.OpenFile(filepath.Join(dir, "acks.jsonl"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600); err != nil {
		return nil, err
	}
	return j, nil
}

// Append durably records a new operation and returns it with its id and sequence.
func (j *Journal) Append(opType, performedBy string, payload map[string]any) (Op, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	op := Op{ClientOpID: newUUID(), Sequence: j.nextSeq, OpType: opType, OccurredAt: time.Now().UTC(), PerformedBy: performedBy, Payload: payload}
	if err := writeLine(j.opsFile, op); err != nil {
		return Op{}, err
	}
	j.ops = append(j.ops, op)
	j.nextSeq++
	return op, nil
}

// Pending returns unacknowledged ops in sequence order.
func (j *Journal) Pending(limit int) []Op {
	j.mu.Lock()
	defer j.mu.Unlock()
	out := []Op{}
	for _, op := range j.ops {
		if _, done := j.acks[op.ClientOpID]; !done {
			out = append(out, op)
			if len(out) == limit {
				break
			}
		}
	}
	return out
}

func (j *Journal) Acknowledge(acks []Ack) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	for _, a := range acks {
		if _, seen := j.acks[a.ClientOpID]; seen {
			continue
		}
		if a.AckedAt.IsZero() {
			a.AckedAt = time.Now().UTC()
		}
		if err := writeLine(j.ackFile, a); err != nil {
			return err
		}
		j.acks[a.ClientOpID] = a
	}
	return nil
}

func (j *Journal) Stats() (total, pending int, conflicts []Ack) {
	j.mu.Lock()
	defer j.mu.Unlock()
	for _, op := range j.ops {
		a, done := j.acks[op.ClientOpID]
		if !done {
			pending++
		} else if a.Status == "CONFLICT" || a.Status == "REJECTED" {
			conflicts = append(conflicts, a)
		}
	}
	return len(j.ops), pending, conflicts
}

func (j *Journal) Close() error {
	return errors.Join(j.opsFile.Close(), j.ackFile.Close())
}

func writeLine(f *os.File, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if _, err := f.Write(append(b, '\n')); err != nil {
		return err
	}
	return f.Sync() // durable before we acknowledge to the scanner
}

func readLines(path string, fn func([]byte) error) error {
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1024*1024), 1024*1024)
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		if err := fn(line); err != nil {
			// A torn final line (power loss mid-write) is skipped, earlier corruption is fatal.
			if !sc.Scan() {
				return nil
			}
			return err
		}
	}
	return sc.Err()
}

func newUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
