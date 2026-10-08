//go:build !windows

package backend

import (
	"fmt"
	"os"
)

// checkCredentialPermissions refuses a credential file other users can read: it
// holds a bearer token.
func checkCredentialPermissions(path string, info os.FileInfo) error {
	if info.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("%s: %s is readable by other users (mode %o); run chmod 600 on it", Name, path, info.Mode().Perm())
	}
	return nil
}
