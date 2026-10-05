package target

import "os"

// writable reports whether dir is writable. Windows grants writes through ACLs that the
// read-only attribute of a directory does not reflect, so only that attribute is checked here;
// Jupyter reports a refused write itself.
func writable(dir string) bool {
	st, err := os.Stat(dir)
	return err == nil && st.Mode().Perm()&0o200 != 0
}
