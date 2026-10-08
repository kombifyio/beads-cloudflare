//go:build windows

package backend

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

func icacls(t *testing.T, args ...string) {
	t.Helper()
	if out, err := exec.Command("icacls", args...).CombinedOutput(); err != nil {
		t.Fatalf("icacls %v: %v\n%s", args, err, out)
	}
}

// A credential file readable by anyone but its owner, SYSTEM and the
// Administrators is refused with the one-line fix; one only they can read passes.
func TestCredentialFileACL(t *testing.T) {
	token, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	me := "*" + token.User.Sid.String()

	cases := []struct {
		name    string
		grant   string // an extra read grant, empty for none
		refused bool
	}{
		{"owner only", "", false},
		{"everyone", "*S-1-1-0:R", true},
		{"users", "*S-1-5-32-545:R", true},
		{"authenticated users", "*S-1-5-11:R", true},
		{"write-only trust modification", "*S-1-5-11:W", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "credentials.json")
			if err := os.WriteFile(path, []byte(`{}`), 0o600); err != nil {
				t.Fatal(err)
			}
			icacls(t, path, "/inheritance:r", "/grant:r", me+":F")
			if tc.grant != "" {
				icacls(t, path, "/grant", tc.grant)
			}
			info, err := os.Stat(path)
			if err != nil {
				t.Fatal(err)
			}
			err = checkCredentialPermissions(path, info)
			if tc.refused {
				if err == nil {
					t.Fatalf("a file granted %s was accepted", tc.grant)
				}
				if !strings.Contains(err.Error(), "icacls") || strings.Contains(err.Error(), "\n") {
					t.Fatalf("the error must carry a one-line icacls fix, got %q", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("an owner-only file was refused: %v", err)
			}
		})
	}
}

// Every entry type that can grant read is classified as granting, and a type the
// check does not know is refused rather than waved through.
func TestClassifyACE(t *testing.T) {
	for typ, want := range map[uint8]aceKind{
		0: aceGrant, 9: aceGrant, 5: aceGrantObject, 11: aceGrantObject, 4: aceCompound,
		1: aceNoGrant, 10: aceNoGrant, 2: aceNoGrant, 17: aceNoGrant, 99: aceUnknown,
	} {
		if got := classifyACE(typ); got != want {
			t.Errorf("ACE type %d classified %d, want %d", typ, got, want)
		}
	}
}

// A conditional allow for Users is a way to read the file, and is refused.
func TestCredentialFileConditionalACE(t *testing.T) {
	token, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "credentials.json")
	if err := os.WriteFile(path, []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	sddl := "D:PAI(A;;FA;;;" + token.User.Sid.String() + ")(XA;;FR;;;WD;(Member_of {SID(BU)}))"
	script := "$a = Get-Acl -LiteralPath '" + path + "'; $a.SetSecurityDescriptorSddlForm('" + sddl + "', 'Access'); Set-Acl -LiteralPath '" + path + "' -AclObject $a"
	if out, err := exec.Command("powershell", "-NoProfile", "-Command", script).CombinedOutput(); err != nil {
		t.Skipf("this host cannot set a conditional ACE: %v\n%s", err, out)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := checkCredentialPermissions(path, info); err == nil {
		t.Fatal("a file readable by Users through a conditional ACE was accepted")
	}
}
