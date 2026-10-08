package state

import (
	"bytes"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"

	"parallax/connector/protocol"
)

func env(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestStateDirPerOS(t *testing.T) {
	cases := []struct {
		name string
		goos string
		env  map[string]string
		home string
		want string
	}{
		{"linux default", "linux", nil, "/home/ada", filepath.Join("/home/ada", ".config", "parallax-connector")},
		{"linux XDG", "linux", map[string]string{"XDG_CONFIG_HOME": "/xdg"}, "/home/ada", filepath.Join("/xdg", "parallax-connector")},
		{"linux relative XDG ignored", "linux", map[string]string{"XDG_CONFIG_HOME": "rel"}, "/home/ada", filepath.Join("/home/ada", ".config", "parallax-connector")},
		{"macOS", "darwin", map[string]string{"XDG_CONFIG_HOME": "/xdg"}, "/Users/ada", filepath.Join("/Users/ada", "Library", "Application Support", "parallax-connector")},
		{"windows", "windows", map[string]string{"APPDATA": `C:\Users\ada\AppData\Roaming`}, `C:\Users\ada`, `C:\Users\ada\AppData\Roaming\parallax-connector`},
		{"windows trailing separator", "windows", map[string]string{"APPDATA": `C:\Users\ada\AppData\Roaming\`}, `C:\Users\ada`, `C:\Users\ada\AppData\Roaming\parallax-connector`},
		{"override linux", "linux", map[string]string{HomeEnv: "/tmp/pc", "XDG_CONFIG_HOME": "/xdg"}, "/home/ada", "/tmp/pc"},
		{"override macOS", "darwin", map[string]string{HomeEnv: "/tmp/pc"}, "/Users/ada", "/tmp/pc"},
		{"override windows", "windows", map[string]string{HomeEnv: `D:\pc`, "APPDATA": `C:\x`}, `C:\Users\ada`, `D:\pc`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := DirFor(c.goos, env(c.env), c.home)
			if err != nil {
				t.Fatal(err)
			}
			if got != c.want {
				t.Fatalf("got %q, want %q", got, c.want)
			}
		})
	}
	for _, c := range []struct {
		name string
		goos string
		env  map[string]string
		home string
	}{
		{"relative override", "linux", map[string]string{HomeEnv: "state"}, "/home/ada"},
		{"windows without APPDATA", "windows", nil, `C:\Users\ada`},
		{"windows relative override", "windows", map[string]string{HomeEnv: `pc`}, `C:\Users\ada`},
		{"linux without home", "linux", nil, ""},
	} {
		t.Run(c.name, func(t *testing.T) {
			if dir, err := DirFor(c.goos, env(c.env), c.home); err == nil {
				t.Fatalf("expected an error, got %q", dir)
			}
		})
	}
}

func TestIdentityKeyMode0600(t *testing.T) {
	s := Open(filepath.Join(t.TempDir(), "state"))
	if err := s.WritePrivate(IdentityFile, []byte("key")); err != nil {
		t.Fatal(err)
	}
	if err := s.CheckPrivate(""); err != nil {
		t.Fatalf("state directory: %v", err)
	}
	if err := s.CheckPrivate(IdentityFile); err != nil {
		t.Fatalf("identity.key: %v", err)
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(s.Path(IdentityFile))
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("identity.key mode %04o, want 0600", info.Mode().Perm())
		}
		dir, _ := os.Stat(s.Dir)
		if dir.Mode().Perm() != 0o700 {
			t.Fatalf("state directory mode %04o, want 0700", dir.Mode().Perm())
		}
		// A file another account can read is reported.
		if err := os.Chmod(s.Path(IdentityFile), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := s.CheckPrivate(IdentityFile); err == nil {
			t.Fatal("a 0644 key was reported private")
		}
		// Rewriting restores owner-only permissions.
		if err := s.WritePrivate(IdentityFile, []byte("key2")); err != nil {
			t.Fatal(err)
		}
		if err := s.CheckPrivate(IdentityFile); err != nil {
			t.Fatal(err)
		}
	}
}

func TestWritePrivateIsAtomic(t *testing.T) {
	s := Open(t.TempDir())
	if err := s.WritePrivate(ConfigFile, []byte("one")); err != nil {
		t.Fatal(err)
	}
	if err := s.WritePrivate(ConfigFile, []byte("two")); err != nil {
		t.Fatal(err)
	}
	data, err := s.ReadFile(ConfigFile)
	if err != nil || string(data) != "two" {
		t.Fatalf("got %q, %v", data, err)
	}
	entries, _ := os.ReadDir(s.Dir)
	for _, e := range entries {
		if strings.Contains(e.Name(), ".tmp-") {
			t.Fatalf("temporary file left behind: %s", e.Name())
		}
	}
}

func validConfig() Config {
	return Config{
		V:           1,
		Server:      "https://parallax.example.org",
		ConnectorID: "3f2a6c1e-8b7d-4e5f-9a10-2c4d6e8f0a1b",
		Name:        "Elena's laptop",
		PairedAt:    "2026-10-03T09:30:00Z",
		Mode:        "personal",
	}
}

func TestConfigRoundTripAndExample(t *testing.T) {
	s := Open(t.TempDir())
	if _, err := s.ReadConfig(); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("missing config: %v", err)
	}
	if err := s.WriteConfig(validConfig()); err != nil {
		t.Fatal(err)
	}
	got, err := s.ReadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if *got != validConfig() {
		t.Fatalf("got %+v", got)
	}
	// The protocol's own example parses.
	example, err := os.ReadFile(filepath.Join("..", "..", "protocol", "v1", "examples", "state-Config.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := s.WritePrivate(ConfigFile, example); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ReadConfig(); err != nil {
		t.Fatalf("state-Config.json example: %v", err)
	}
}

func TestConfigValidation(t *testing.T) {
	bad := map[string]func(*Config){
		"version":        func(c *Config) { c.V = 2 },
		"server path":    func(c *Config) { c.Server = "https://parallax.example.org/app" },
		"server upper":   func(c *Config) { c.Server = "https://Parallax.example.org" },
		"server scheme":  func(c *Config) { c.Server = "ftp://parallax.example.org" },
		"connector id":   func(c *Config) { c.ConnectorID = "not-a-uuid" },
		"empty name":     func(c *Config) { c.Name = "" },
		"long name":      func(c *Config) { c.Name = strings.Repeat("x", 61) },
		"pairedAt":       func(c *Config) { c.PairedAt = "2026-10-03 09:30:00" },
		"mode":           func(c *Config) { c.Mode = "shared" },
		"missing server": func(c *Config) { c.Server = "" },
	}
	s := Open(t.TempDir())
	for name, mutate := range bad {
		t.Run(name, func(t *testing.T) {
			c := validConfig()
			mutate(&c)
			if err := s.WriteConfig(c); err == nil {
				t.Fatal("invalid config written")
			}
		})
	}
	for name, body := range map[string]string{
		"unknown field": `{"v":1,"server":"https://p.example","connectorId":"3f2a6c1e-8b7d-4e5f-9a10-2c4d6e8f0a1b","name":"n","pairedAt":"2026-10-03T09:30:00Z","mode":"personal","token":"x"}`,
		"trailing":      `{"v":1,"server":"https://p.example","connectorId":"3f2a6c1e-8b7d-4e5f-9a10-2c4d6e8f0a1b","name":"n","pairedAt":"2026-10-03T09:30:00Z","mode":"personal"} {}`,
	} {
		t.Run(name, func(t *testing.T) {
			if err := s.WritePrivate(ConfigFile, []byte(body)); err != nil {
				t.Fatal(err)
			}
			if _, err := s.ReadConfig(); err == nil {
				t.Fatal("invalid config.json read")
			}
		})
	}
}

func TestReadRuntimeExample(t *testing.T) {
	s := Open(t.TempDir())
	example, err := os.ReadFile(filepath.Join("..", "..", "protocol", "v1", "examples", "state-Runtime.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := s.WritePrivate(RuntimeFile, example); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ReadRuntime(); err != nil {
		t.Fatalf("state-Runtime.json example: %v", err)
	}
}

func TestRunLockIsExclusive(t *testing.T) {
	s := Open(t.TempDir())
	l, err := s.Lock()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Lock(); !errors.Is(err, ErrLocked) {
		t.Fatalf("second lock: %v, want ErrLocked", err)
	}
	if err := l.Release(); err != nil {
		t.Fatal(err)
	}
	l2, err := s.Lock()
	if err != nil {
		t.Fatalf("lock after release: %v", err)
	}
	l2.Release()
}

func TestReadFileRefusesSymlink(t *testing.T) {
	if runtime.GOOS == "windows" {
		return // creating a symbolic link needs extra privileges on Windows
	}
	s := Open(t.TempDir())
	target := filepath.Join(t.TempDir(), "elsewhere")
	if err := os.WriteFile(target, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, s.Path(ConfigFile)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ReadFile(ConfigFile); err == nil {
		t.Fatal("followed a symbolic link")
	}
}

// TestStateValidatorsAgreeWithSchema runs the same valid and invalid config.json and runtime.json
// documents through the Go rules and state.schema.json and requires one verdict from both, so a
// rule tightened or loosened on one side only fails here. The bytes `run` writes for runtime.json
// are checked against the schema in TestRunWritesRuntimeJSON.
func TestStateValidatorsAgreeWithSchema(t *testing.T) {
	data, err := protocol.V1.ReadFile("v1/state.schema.json")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	c := jsonschema.NewCompiler()
	const base = "https://parallax.invalid/connector/v1/state.schema.json"
	if err := c.AddResource(base, doc); err != nil {
		t.Fatal(err)
	}
	schemaAccepts := func(def string, v any) bool {
		sch, err := c.Compile(base + "#/$defs/" + def)
		if err != nil {
			t.Fatal(err)
		}
		body, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		inst, err := jsonschema.UnmarshalJSON(bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		return sch.Validate(inst) == nil
	}

	configs := map[string]func(*Config){
		"valid":          func(*Config) {},
		"name 60":        func(c *Config) { c.Name = strings.Repeat("x", 60) },
		"version":        func(c *Config) { c.V = 2 },
		"server path":    func(c *Config) { c.Server = "https://parallax.example.org/app" },
		"server upper":   func(c *Config) { c.Server = "https://Parallax.example.org" },
		"server scheme":  func(c *Config) { c.Server = "ftp://parallax.example.org" },
		"connector id":   func(c *Config) { c.ConnectorID = "not-a-uuid" },
		"empty name":     func(c *Config) { c.Name = "" },
		"long name":      func(c *Config) { c.Name = strings.Repeat("x", 61) },
		"pairedAt":       func(c *Config) { c.PairedAt = "2026-10-03 09:30:00" },
		"mode":           func(c *Config) { c.Mode = "shared" },
		"missing server": func(c *Config) { c.Server = "" },
	}
	for name, mutate := range configs {
		t.Run("config "+name, func(t *testing.T) {
			cfg := validConfig()
			mutate(&cfg)
			goOK := cfg.Validate() == nil
			if schemaOK := schemaAccepts("Config", cfg); goOK != schemaOK {
				t.Fatalf("Go accepts=%v, schema accepts=%v for %+v", goOK, schemaOK, cfg)
			}
		})
	}

	validRuntime := func() Runtime {
		return Runtime{V: 1, PID: 4242, StartedAt: "2026-10-03T09:30:00Z", Link: "up", Since: "2026-10-03T09:31:00Z", Sessions: 2}
	}
	runtimes := map[string]func(*Runtime){
		"valid":          func(*Runtime) {},
		"fractional":     func(r *Runtime) { r.Since = "2026-10-03T09:31:00.250Z" },
		"last error":     func(r *Runtime) { r.Link = "down"; r.LastError = "link closed" },
		"version":        func(r *Runtime) { r.V = 2 },
		"pid zero":       func(r *Runtime) { r.PID = 0 },
		"link state":     func(r *Runtime) { r.Link = "sleeping" },
		"started offset": func(r *Runtime) { r.StartedAt = "2026-10-03T09:30:00+02:00" },
		"long error":     func(r *Runtime) { r.LastError = strings.Repeat("x", 201) },
		"sessions 65":    func(r *Runtime) { r.Sessions = 65 },
		"sessions -1":    func(r *Runtime) { r.Sessions = -1 },
	}
	for name, mutate := range runtimes {
		t.Run("runtime "+name, func(t *testing.T) {
			rt := validRuntime()
			mutate(&rt)
			goOK := rt.Validate() == nil
			if schemaOK := schemaAccepts("Runtime", rt); goOK != schemaOK {
				t.Fatalf("Go accepts=%v, schema accepts=%v for %+v", goOK, schemaOK, rt)
			}
		})
	}
}
