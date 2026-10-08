//go:build windows

package backend

import (
	"fmt"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

// File access rights that let a principal read the contents of the credential
// file. A generic right is included because an ACE can carry it unmapped.
const (
	fileReadData    = 0x00000001
	fileModifyTrust = 0x000d0006 // write/append data, delete, change DACL/owner
	genericWrite    = 0x40000000
	genericRead     = 0x80000000
	genericAll      = 0x10000000
	genericExecute  = 0x20000000
	inheritOnlyACE  = 0x08
)

// checkCredentialPermissions refuses a credential file that a principal other
// than its owner, SYSTEM and the Administrators group can read. That is the
// Windows spelling of "mode 600": the file holds a bearer token, and a DACL that
// grants Everyone, Users or Authenticated Users read access hands it to every
// local account.
func checkCredentialPermissions(path string, _ os.FileInfo) error {
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return fmt.Errorf("%s: cannot read the access list of %s: %w", Name, path, err)
	}
	owner, _, err := sd.Owner()
	if err != nil {
		return fmt.Errorf("%s: cannot read the owner of %s: %w", Name, path, err)
	}
	dacl, _, err := sd.DACL()
	if err != nil || dacl == nil {
		// A file with no DACL grants full access to everyone.
		return fixACL(path, "everyone has access (no access list)")
	}
	allowed := []*windows.SID{owner}
	for _, kind := range []windows.WELL_KNOWN_SID_TYPE{windows.WinLocalSystemSid, windows.WinBuiltinAdministratorsSid} {
		if sid, err := windows.CreateWellKnownSid(kind); err == nil {
			allowed = append(allowed, sid)
		}
	}
	for i := uint32(0); i < uint32(dacl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, i, &ace); err != nil {
			return fmt.Errorf("%s: cannot read the access list of %s: %w", Name, path, err)
		}
		kind := classifyACE(ace.Header.AceType)
		if kind == aceNoGrant || ace.Header.AceFlags&inheritOnlyACE != 0 {
			continue
		}
		if kind == aceUnknown {
			// An ACE type this check does not know could grant read: refuse it.
			return fixACL(path, fmt.Sprintf("it carries an access entry of type %d this check cannot classify", ace.Header.AceType))
		}
		if kind != aceCompound && uint32(ace.Mask)&(fileReadData|fileModifyTrust|genericRead|genericWrite|genericAll|genericExecute) == 0 {
			continue
		}
		if kind == aceCompound {
			return fixACL(path, "it carries a compound access entry")
		}
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		if kind == aceGrantObject {
			sid = objectACESid(ace)
		}
		trusted := false
		for _, ok := range allowed {
			if ok.Equals(sid) {
				trusted = true
				break
			}
		}
		if !trusted {
			return fixACL(path, "it can be read by "+sid.String())
		}
	}
	return nil
}

// aceKind says what an access control entry type can do to the question "who may
// read this file".
type aceKind int

const (
	aceNoGrant     aceKind = iota // deny, audit, label and policy entries: they grant nothing
	aceGrant                      // allow, and the callback (conditional) allow
	aceGrantObject                // allow with object GUIDs ahead of the SID
	aceCompound                   // compound allow: two principals, never trusted here
	aceUnknown                    // a type this check does not know
)

// classifyACE sorts ACE types. A conditional allow (callback) grants read to its
// principal when its condition holds, which this check cannot evaluate, so it is
// treated as granting: a file readable by Users through a condition is refused.
func classifyACE(t uint8) aceKind {
	switch t {
	case 0, 9: // ACCESS_ALLOWED, ACCESS_ALLOWED_CALLBACK
		return aceGrant
	case 5, 11: // ACCESS_ALLOWED_OBJECT, ACCESS_ALLOWED_CALLBACK_OBJECT
		return aceGrantObject
	case 4: // ACCESS_ALLOWED_COMPOUND
		return aceCompound
	case 1, 6, 10, 12, // denies
		2, 7, 13, 14, 15, // audits
		3, 8, // alarms
		16, 17, 18, 19: // mandatory label, resource attribute, scoped policy, access filter
		return aceNoGrant
	}
	return aceUnknown
}

// objectACESid reads the SID of an object ACE: it follows the mask, a flags word
// and up to two GUIDs.
func objectACESid(ace *windows.ACCESS_ALLOWED_ACE) *windows.SID {
	base := unsafe.Pointer(&ace.SidStart)
	flags := *(*uint32)(base)
	offset := uintptr(4)
	if flags&1 != 0 {
		offset += 16
	}
	if flags&2 != 0 {
		offset += 16
	}
	return (*windows.SID)(unsafe.Add(base, offset))
}

func fixACL(path, why string) error {
	return fmt.Errorf("%s: %s is readable by other accounts (%s); run: icacls \"%s\" /inheritance:r /grant:r \"%%USERNAME%%:F\"",
		Name, path, why, path)
}
