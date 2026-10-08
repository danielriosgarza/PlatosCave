package session

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"regexp"
	"time"

	"parallax/connector/internal/protocol"
	"parallax/connector/internal/state"
)

// maxPID is the largest process id sessions.json holds (state.schema.json): Windows ids are
// 32-bit, above Linux's 4194304.
const maxPID = 1<<32 - 1

// maxRecords is the most records sessions.json holds (state.schema.json#/$defs/Sessions).
const maxRecords = 64

// File is sessions.json (state.schema.json#/$defs/Sessions).
type File struct {
	V        int      `json:"v"`
	Sessions []Record `json:"sessions"`
}

// Record is one session the connector holds, or stopped and has not yet reported
// (state.schema.json#/$defs/SessionRecord). It has no field a token, key, passphrase or password
// could be written to: the target is the secret-free reference the server sent.
type Record struct {
	SessionID      string          `json:"sessionId"`
	Owned          bool            `json:"owned"`
	State          string          `json:"state"`
	Cause          string          `json:"cause,omitempty"`
	StoppedAt      string          `json:"stoppedAt,omitempty"`
	Target         protocol.Target `json:"target"`
	KernelIDs      []string        `json:"kernelIds,omitempty"`
	StartedAt      string          `json:"startedAt,omitempty"`
	Process        *ProcessRecord  `json:"process,omitempty"`
	Lease          protocol.Lease  `json:"lease"`
	Phase          string          `json:"phase"`
	LastActivityAt string          `json:"lastActivityAt"`
	DetachedAt     string          `json:"detachedAt,omitempty"`
	ExpiresAt      string          `json:"expiresAt"`
	HardDeadline   string          `json:"hardDeadline"`
}

// ProcessRecord is an owned session's server process, which the orphan sweep needs.
type ProcessRecord struct {
	Where     string `json:"where"` // local or remote
	PID       int    `json:"pid"`
	Port      int    `json:"port"`
	StartedAt string `json:"startedAt"`
}

var (
	reUUID      = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	reTimestamp = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$`)
	reKernelID  = regexp.MustCompile(`^[A-Za-z0-9-]{1,64}$`)
	recordState = map[string]bool{StateStarting: true, StateReady: true, StateDisconnected: true, StateStopping: true, StateStopped: true}
	recordCause = map[string]bool{
		"sleep": true, "vpn": true, "network_change": true, "ssh_timeout": true, "service_stopped": true,
		"allocation_expired": true, "host_unreachable": true, "process_exited": true, "lease_idle": true,
		"lease_grace": true, "user_stop": true, "connector_exit": true, "connector_restarted": true, "max_lifetime": true,
	}
)

func timestampOK(s string) bool {
	if !reTimestamp.MatchString(s) {
		return false
	}
	_, err := time.Parse(time.RFC3339Nano, s)
	return err == nil
}

// validate applies the rules of state.schema.json#/$defs/Sessions that a reader relies on.
func (f *File) validate() error {
	if f.V != 1 {
		return fmt.Errorf("v must be 1, got %d", f.V)
	}
	if len(f.Sessions) > maxRecords {
		return fmt.Errorf("more than %d sessions", maxRecords)
	}
	for _, r := range f.Sessions {
		if err := r.validate(); err != nil {
			return fmt.Errorf("session %q: %w", r.SessionID, err)
		}
	}
	return nil
}

func (r *Record) validate() error {
	switch {
	case !reUUID.MatchString(r.SessionID):
		return errors.New("sessionId is not a lower-case UUID")
	case !recordState[r.State]:
		return fmt.Errorf("state %q is not a record state", r.State)
	case r.Cause != "" && !recordCause[r.Cause]:
		return fmt.Errorf("cause %q is not a connector cause", r.Cause)
	case r.StoppedAt != "" && !timestampOK(r.StoppedAt):
		return errors.New("stoppedAt is not an RFC 3339 UTC time")
	case r.Phase != PhaseAttached && r.Phase != PhaseDetached:
		return fmt.Errorf("phase %q is not attached or detached", r.Phase)
	case !timestampOK(r.LastActivityAt) || !timestampOK(r.ExpiresAt) || !timestampOK(r.HardDeadline):
		return errors.New("lastActivityAt, expiresAt and hardDeadline must be RFC 3339 UTC times")
	case r.DetachedAt != "" && !timestampOK(r.DetachedAt), r.StartedAt != "" && !timestampOK(r.StartedAt):
		return errors.New("detachedAt and startedAt must be RFC 3339 UTC times")
	case r.Lease.IdleTimeoutMin < 5 || r.Lease.IdleTimeoutMin > 240 || r.Lease.GracePeriodMin < 1 || r.Lease.GracePeriodMin > 60:
		return errors.New("lease out of bounds")
	case len(r.KernelIDs) > 16:
		return errors.New("more than 16 kernel ids")
	}
	for _, id := range r.KernelIDs {
		if !reKernelID.MatchString(id) {
			return fmt.Errorf("kernel id %q", id)
		}
	}
	if p := r.Process; p != nil {
		switch {
		case p.Where != "local" && p.Where != "remote":
			return fmt.Errorf("process.where %q", p.Where)
		case p.PID < 1 || int64(p.PID) > maxPID: // a Windows process id is any 32-bit value
			return fmt.Errorf("process.pid %d out of range", p.PID)
		case p.Port < 1 || p.Port > 65535:
			return fmt.Errorf("process.port %d out of range", p.Port)
		case !timestampOK(p.StartedAt):
			return errors.New("process.startedAt is not an RFC 3339 UTC time")
		}
	}
	switch r.Target.Kind {
	case protocol.TargetLocal, protocol.TargetSSH, protocol.TargetManaged:
	default:
		return fmt.Errorf("target kind %q", r.Target.Kind)
	}
	return nil
}

// readFile reads sessions.json; a missing file is an empty list.
func readFile(store *state.Store) (*File, error) {
	data, err := store.ReadFile(state.SessionsFile)
	if errors.Is(err, fs.ErrNotExist) {
		return &File{V: 1}, nil
	}
	if err != nil {
		return nil, err
	}
	var f File
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&f); err != nil {
		return nil, err
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, errors.New("trailing data after the JSON value")
	}
	if err := f.validate(); err != nil {
		return nil, err
	}
	return &f, nil
}

// writeFile validates and atomically replaces sessions.json (temporary file, then rename, mode
// 0600).
func writeFile(store *state.Store, f *File) error {
	if err := f.validate(); err != nil {
		return fmt.Errorf("sessions.json: %w", err)
	}
	data, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	return store.WritePrivate(state.SessionsFile, append(data, '\n'))
}

func stamp(t time.Time) string { return t.UTC().Format(time.RFC3339) }

// parseStamp reads a timestamp the file validated; the zero time for "".
func parseStamp(s string) time.Time {
	t, _ := time.Parse(time.RFC3339Nano, s)
	return t
}
