// Package managed is the connector's managed mode (docs/design/connector.md §12): `run --managed`
// for a connector an institution operates next to Parallax. Its configuration comes only from
// the environment and nothing under it asks a question; its scope starts empty; host keys are
// pinned by the operator; a learner names a target by targetId and never chooses a host, a port
// or an account.
package managed

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"parallax/connector/internal/identity"
	"parallax/connector/internal/netscope"
	"parallax/connector/internal/pairing"
	"parallax/connector/internal/sshtarget"
)

// The environment of a managed connector (design §12). PARALLAX_ALLOW_NET, PARALLAX_ALLOW_HOSTS
// and PARALLAX_ALLOW_PORTS are netscope's.
const (
	EnvServer         = "PARALLAX_SERVER"
	EnvConnectorID    = "PARALLAX_CONNECTOR_ID"
	EnvIdentityKey    = "PARALLAX_IDENTITY_KEY_FILE"
	EnvKnownHostsFile = "PARALLAX_KNOWN_HOSTS_FILE"
	EnvTargetsFile    = "PARALLAX_TARGETS_FILE"
	EnvKeysDir        = "PARALLAX_KEYS_DIR"
)

// Config is a managed connector's configuration, checked.
type Config struct {
	// Server is the normalised origin the connector links to and signs.
	Server      string
	ConnectorID string
	Identity    *identity.Identity
	Scope       netscope.Scope
	// KnownHostsFile is the operator's pinned known_hosts; it is never written.
	KnownHostsFile string
	Keys           *Keys
	Targets        *Targets
}

// Load reads and checks the configuration. Every refusal names the variable to fix.
func Load(getenv func(string) string) (*Config, error) {
	cfg := &Config{}
	server := getenv(EnvServer)
	if server == "" {
		return nil, fmt.Errorf("%s is not set", EnvServer)
	}
	origin, err := pairing.NormaliseServer(server)
	if err != nil {
		return nil, fmt.Errorf("%s: %v", EnvServer, err)
	}
	cfg.Server = origin
	cfg.ConnectorID = getenv(EnvConnectorID)
	if _, err := identity.ParseUUID(cfg.ConnectorID); err != nil {
		return nil, fmt.Errorf("%s: %v (the id printed by connectors:register-managed)", EnvConnectorID, err)
	}

	idPath, err := absPath(getenv, EnvIdentityKey)
	if err != nil {
		return nil, err
	}
	data, err := readSecret(idPath)
	if err != nil {
		return nil, fmt.Errorf("%s: %v", EnvIdentityKey, err)
	}
	if cfg.Identity, err = identity.ParsePEM(data); err != nil {
		return nil, fmt.Errorf("%s: %v", EnvIdentityKey, err)
	}

	cfg.Scope, err = netscope.ParseManagedScope(getenv(netscope.EnvAllowNet), getenv(netscope.EnvAllowHosts), getenv(netscope.EnvAllowPorts))
	if err != nil {
		return nil, err
	}

	if cfg.KnownHostsFile, err = absPath(getenv, EnvKnownHostsFile); err != nil {
		return nil, err
	}
	if err := checkPinned(cfg.KnownHostsFile); err != nil {
		return nil, fmt.Errorf("%s: %v", EnvKnownHostsFile, err)
	}

	keysDir, err := absPath(getenv, EnvKeysDir)
	if err != nil {
		return nil, err
	}
	if err := checkDir(keysDir); err != nil {
		return nil, fmt.Errorf("%s: %v", EnvKeysDir, err)
	}
	cfg.Keys = &Keys{Dir: keysDir}

	targetsPath, err := absPath(getenv, EnvTargetsFile)
	if err != nil {
		return nil, err
	}
	raw, err := readBounded(targetsPath)
	if err != nil {
		return nil, fmt.Errorf("%s: %v", EnvTargetsFile, err)
	}
	if cfg.Targets, err = ParseTargets(raw, cfg.Scope, cfg.Keys); err != nil {
		return nil, fmt.Errorf("%s: %v", EnvTargetsFile, err)
	}
	return cfg, nil
}

func absPath(getenv func(string) string, name string) (string, error) {
	p := getenv(name)
	if p == "" {
		return "", fmt.Errorf("%s is not set", name)
	}
	if !filepath.IsAbs(p) {
		return "", fmt.Errorf("%s must be an absolute path, got %q", name, p)
	}
	return filepath.Clean(p), nil
}

// checkPinned refuses a known_hosts file that is missing, not a regular file, writable by the
// group or other accounts, or unreadable as OpenSSH known_hosts.
func checkPinned(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("%s is not a regular file", path)
	}
	if perm := info.Mode().Perm(); perm&0o022 != 0 {
		return fmt.Errorf("%s has mode %04o; the group or other accounts can change it", path, perm)
	}
	if _, err := (&sshtarget.KnownHosts{Path: path}).Lookup("parallax.invalid", 22); err != nil {
		return err
	}
	return nil
}

// checkDir refuses a key directory that is missing or writable by the group or other accounts.
func checkDir(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return errors.New(path + " is not a directory")
	}
	if perm := info.Mode().Perm(); perm&0o022 != 0 {
		return fmt.Errorf("%s has mode %04o; the group or other accounts can change it", path, perm)
	}
	return nil
}
