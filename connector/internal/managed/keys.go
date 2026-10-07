package managed

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
)

// maxKeyFile bounds a key, certificate or identity file.
const maxKeyFile = 64 << 10

// CheckSecret refuses a secret file that is not a regular file or that the group or other
// accounts can read or write (design §12): the operator must give it mode 0600 or 0400. A
// symbolic link is followed, as a mounted container secret is often one; the file it names is
// judged.
func CheckSecret(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("%s is not a regular file", path)
	}
	if perm := info.Mode().Perm(); perm&0o077 != 0 {
		return fmt.Errorf("%s has mode %04o; the group or other accounts can access it (want 0600 or 0400)", path, perm)
	}
	return nil
}

// readSecret reads a secret file after CheckSecret passed.
func readSecret(path string) ([]byte, error) {
	if err := CheckSecret(path); err != nil {
		return nil, err
	}
	return readBounded(path)
}

func readBounded(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxKeyFile+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxKeyFile {
		return nil, fmt.Errorf("%s is larger than %d bytes", path, maxKeyFile)
	}
	return data, nil
}

// Keys is PARALLAX_KEYS_DIR: one SSH private key per keyId, named by the keyId, and optionally
// its certificate as <keyId>-cert.pub. The connector only reads it.
type Keys struct {
	Dir string
}

// Check refuses a key that is missing or whose permissions are too loose.
func (k *Keys) Check(keyID string) error {
	return CheckSecret(filepath.Join(k.Dir, keyID))
}

// Read returns the private key keyID names and its certificate (nil when there is none). The
// permissions are checked again on every read, so a key loosened while the connector runs is
// refused from then on.
func (k *Keys) Read(keyID string) (key, cert []byte, err error) {
	if !validID(keyID) {
		return nil, nil, fmt.Errorf("%q is not a key id", keyID)
	}
	key, err = readSecret(filepath.Join(k.Dir, keyID))
	if err != nil {
		return nil, nil, err
	}
	cert, err = readBounded(filepath.Join(k.Dir, keyID+"-cert.pub"))
	if errors.Is(err, fs.ErrNotExist) {
		return key, nil, nil
	}
	if err != nil {
		return nil, nil, err
	}
	return key, cert, nil
}
