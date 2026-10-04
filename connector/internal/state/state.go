// Package state owns the connector's state directory (docs/design/connector.md §13): where it
// is on each OS, owner-only permissions, atomic writes, config.json and the run lock.
package state

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"unicode/utf8"
)

var goos = runtime.GOOS

// Files in the state directory.
const (
	IdentityFile   = "identity.key"
	ConfigFile     = "config.json"
	KnownHostsFile = "known_hosts"
	SessionsFile   = "sessions.json"
	RuntimeFile    = "runtime.json"
	LockFile       = "run.lock"
)

// HomeEnv overrides the state directory (CI and tests use a temporary one).
const HomeEnv = "PARALLAX_CONNECTOR_HOME"

const appDir = "parallax-connector"

// maxStateFile bounds every read of a state file; none is legitimately larger.
const maxStateFile = 1 << 20

// Dir returns the state directory for this computer.
func Dir() (string, error) {
	home, _ := os.UserHomeDir()
	return DirFor(goos, os.Getenv, home)
}

// DirFor returns the state directory for an operating system, an environment and a home
// directory: PARALLAX_CONNECTOR_HOME, else $XDG_CONFIG_HOME/parallax-connector (default
// ~/.config/…) on Linux, ~/Library/Application Support/parallax-connector on macOS and
// %APPDATA%\parallax-connector on Windows.
func DirFor(goos string, getenv func(string) string, home string) (string, error) {
	if dir := getenv(HomeEnv); dir != "" {
		if !isAbs(goos, dir) {
			return "", fmt.Errorf("%s must be an absolute path, got %q", HomeEnv, dir)
		}
		return dir, nil
	}
	switch goos {
	case "windows":
		appData := getenv("APPDATA")
		if appData == "" || !isAbs(goos, appData) {
			return "", errors.New("APPDATA is not set; set " + HomeEnv + " to choose a state directory")
		}
		return strings.TrimRight(appData, `\/`) + `\` + appDir, nil
	case "darwin":
		if home == "" {
			return "", errors.New("no home directory; set " + HomeEnv + " to choose a state directory")
		}
		return filepath.Join(home, "Library", "Application Support", appDir), nil
	default:
		if xdg := getenv("XDG_CONFIG_HOME"); xdg != "" && filepath.IsAbs(xdg) {
			return filepath.Join(xdg, appDir), nil
		}
		if home == "" {
			return "", errors.New("no home directory; set " + HomeEnv + " to choose a state directory")
		}
		return filepath.Join(home, ".config", appDir), nil
	}
}

var windowsAbs = regexp.MustCompile(`^([A-Za-z]:[\\/]|\\\\)`)

func isAbs(goos, p string) bool {
	if goos == "windows" {
		return windowsAbs.MatchString(p)
	}
	return len(p) > 0 && p[0] == '/'
}

// Store is one state directory.
type Store struct {
	Dir string
}

// Open returns the store for dir without creating anything.
func Open(dir string) *Store {
	return &Store{Dir: dir}
}

// Path returns the path of a file in the store.
func (s *Store) Path(name string) string {
	return filepath.Join(s.Dir, name)
}

// Ensure creates the directory if needed and makes it owner-only.
func (s *Store) Ensure() error {
	if err := os.MkdirAll(s.Dir, 0o700); err != nil {
		return fmt.Errorf("create state directory: %w", err)
	}
	if err := restrict(s.Dir, true); err != nil {
		return fmt.Errorf("restrict state directory: %w", err)
	}
	return nil
}

// Exists reports whether a file is present in the store.
func (s *Store) Exists(name string) (bool, error) {
	_, err := os.Lstat(s.Path(name))
	if err == nil {
		return true, nil
	}
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	return false, err
}

// ReadFile reads a state file, refusing symbolic links and files over 1 MiB. A missing file
// is an error matching fs.ErrNotExist.
func (s *Store) ReadFile(name string) ([]byte, error) {
	p := s.Path(name)
	info, err := os.Lstat(p)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("%s is not a regular file", p)
	}
	f, err := os.Open(p)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxStateFile+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxStateFile {
		return nil, fmt.Errorf("%s is larger than %d bytes", p, maxStateFile)
	}
	return data, nil
}

// WritePrivate replaces a state file atomically: the data goes to an owner-only temporary file
// in the same directory, is flushed, and is renamed over the old file. A reader sees the old
// content or the new, never a mix, and the file is never readable by another account.
func (s *Store) WritePrivate(name string, data []byte) error {
	if err := s.Ensure(); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(s.Dir, "."+name+".tmp-*")
	if err != nil {
		return fmt.Errorf("write %s: %w", name, err)
	}
	tmpName := tmp.Name()
	done := false
	defer func() {
		if !done {
			tmp.Close()
			os.Remove(tmpName)
		}
	}()
	if err := tmp.Chmod(0o600); err != nil && !errors.Is(err, errors.ErrUnsupported) {
		return fmt.Errorf("write %s: %w", name, err)
	}
	if err := restrict(tmpName, false); err != nil {
		return fmt.Errorf("restrict %s: %w", name, err)
	}
	if _, err := tmp.Write(data); err != nil {
		return fmt.Errorf("write %s: %w", name, err)
	}
	if err := tmp.Sync(); err != nil {
		return fmt.Errorf("write %s: %w", name, err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("write %s: %w", name, err)
	}
	if err := os.Rename(tmpName, s.Path(name)); err != nil {
		return fmt.Errorf("write %s: %w", name, err)
	}
	done = true
	syncDir(s.Dir)
	return nil
}

// Remove deletes state files; a file that is already gone is not an error.
func (s *Store) Remove(names ...string) error {
	var errs []error
	for _, name := range names {
		if err := os.Remove(s.Path(name)); err != nil && !errors.Is(err, fs.ErrNotExist) {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// CheckPrivate reports an error when a file or directory in the store (or the store itself,
// for name "") can be read or written by another account: on Unix any group or other
// permission bit, on Windows a DACL that is not protected or grants anyone but the owner.
func (s *Store) CheckPrivate(name string) error {
	p := s.Dir
	if name != "" {
		p = s.Path(name)
	}
	return checkPrivate(p)
}

// Config is config.json (state.schema.json#/$defs/Config).
type Config struct {
	V           int    `json:"v"`
	Server      string `json:"server"`
	ConnectorID string `json:"connectorId"`
	Name        string `json:"name"`
	PairedAt    string `json:"pairedAt"`
	Mode        string `json:"mode"`
}

var (
	serverPattern    = regexp.MustCompile(`^https?://[a-z0-9.:\[\]-]+$`)
	uuidPattern      = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	timestampPattern = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$`)
)

// Validate applies the rules of state.schema.json#/$defs/Config.
func (c Config) Validate() error {
	switch {
	case c.V != 1:
		return fmt.Errorf("config.json: v must be 1, got %d", c.V)
	case len(c.Server) > 255 || !serverPattern.MatchString(c.Server):
		return fmt.Errorf("config.json: server %q is not a normalised origin", c.Server)
	case !uuidPattern.MatchString(c.ConnectorID):
		return fmt.Errorf("config.json: connectorId %q is not a lower-case UUID", c.ConnectorID)
	case !utf8.ValidString(c.Name) || utf8.RuneCountInString(c.Name) < 1 || utf8.RuneCountInString(c.Name) > 60:
		return errors.New("config.json: name must be 1 to 60 characters")
	case !timestampPattern.MatchString(c.PairedAt):
		return fmt.Errorf("config.json: pairedAt %q is not an RFC 3339 UTC time", c.PairedAt)
	case c.Mode != "personal" && c.Mode != "managed":
		return fmt.Errorf("config.json: mode %q is not personal or managed", c.Mode)
	}
	return nil
}

// ReadConfig reads and validates config.json. A missing file matches fs.ErrNotExist.
func (s *Store) ReadConfig() (*Config, error) {
	data, err := s.ReadFile(ConfigFile)
	if err != nil {
		return nil, err
	}
	var c Config
	if err := decodeStrict(data, &c); err != nil {
		return nil, fmt.Errorf("config.json: %w", err)
	}
	if err := c.Validate(); err != nil {
		return nil, err
	}
	return &c, nil
}

// WriteConfig validates and atomically writes config.json.
func (s *Store) WriteConfig(c Config) error {
	if err := c.Validate(); err != nil {
		return err
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return s.WritePrivate(ConfigFile, append(data, '\n'))
}

// Runtime is runtime.json (state.schema.json#/$defs/Runtime), written by `run` while it is alive.
type Runtime struct {
	V         int    `json:"v"`
	PID       int    `json:"pid"`
	StartedAt string `json:"startedAt"`
	Link      string `json:"link"`
	Since     string `json:"since"`
	LastError string `json:"lastError,omitempty"`
	Sessions  int    `json:"sessions"`
}

var linkStates = map[string]bool{
	"connecting": true, "authenticating": true, "up": true, "down": true,
	"pending": true, "revoked": true, "rejected": true,
}

// Validate applies the rules of state.schema.json#/$defs/Runtime.
func (r Runtime) Validate() error {
	switch {
	case r.V != 1:
		return fmt.Errorf("runtime.json: v must be 1, got %d", r.V)
	case r.PID < 1 || int64(r.PID) > 4294967295: // Windows process ids are 32-bit
		return fmt.Errorf("runtime.json: pid %d out of range", r.PID)
	case !timestampPattern.MatchString(r.StartedAt) || !timestampPattern.MatchString(r.Since):
		return errors.New("runtime.json: startedAt and since must be RFC 3339 UTC times")
	case !linkStates[r.Link]:
		return fmt.Errorf("runtime.json: link %q is not a known state", r.Link)
	case utf8.RuneCountInString(r.LastError) > 200:
		return errors.New("runtime.json: lastError is longer than 200 characters")
	case r.Sessions < 0 || r.Sessions > 64:
		return fmt.Errorf("runtime.json: sessions %d out of range", r.Sessions)
	}
	return nil
}

// ReadRuntime reads and validates runtime.json. A missing file matches fs.ErrNotExist.
func (s *Store) ReadRuntime() (*Runtime, error) {
	data, err := s.ReadFile(RuntimeFile)
	if err != nil {
		return nil, err
	}
	var r Runtime
	if err := decodeStrict(data, &r); err != nil {
		return nil, fmt.Errorf("runtime.json: %w", err)
	}
	if err := r.Validate(); err != nil {
		return nil, err
	}
	return &r, nil
}

// decodeStrict decodes exactly one JSON value with no unknown fields.
func decodeStrict(data []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return err
	}
	if dec.More() {
		return errors.New("trailing data after the JSON value")
	}
	var extra json.RawMessage
	if err := dec.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("trailing data after the JSON value")
	}
	return nil
}
