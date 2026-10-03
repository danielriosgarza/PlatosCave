package state

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
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
