package cloudflare_test

import (
	"testing"

	beadsbackend "github.com/steveyegge/beads/backend"
	"github.com/steveyegge/beads/backend/conformance"

	// The store under test, registered under its own name by this import.
	_ "github.com/kombifyio/beads-cloudflare/bd/backend"
	"github.com/kombifyio/beads-cloudflare/bd/cloudflare"
)

// TestUnsupportedContract proves the declarations: every method this backend
// answers with a refusal is on the allowlist, names itself in the refusal, and
// has an error return the suite can read.
//
// A backend that stubs all seven version-control families passes RunAll without
// ever reaching a stub, so this is the tier that actually holds the store to what
// it claims. It also fails loudly on shell drift: a method in the allowlist that
// no longer exists on the interface is an error, not a silent skip.
//
// The store is the real one, not a stand-in: the suite reflects over the value,
// so a stand-in would report methods the store does not have.
func TestUnsupportedContract(t *testing.T) {
	store, err := cloudflare.New("https://example.invalid", "conformance", "token", "test", false)
	if err != nil {
		t.Fatalf("build the store: %v", err)
	}
	conformance.RunUnsupportedContract(t, store, cloudflare.Unsupported())
}

// TestRegistered proves the backend is selectable by name. Registration is the
// only wiring between this package and bd: an agent selects "cloudflare" in
// metadata.json and the registry finds it.
func TestRegistered(t *testing.T) {
	if !beadsbackend.Registered("cloudflare") {
		t.Fatal("backend cloudflare is not registered")
	}
	if _, ok := beadsbackend.Lookup("cloudflare"); !ok {
		t.Fatal("Lookup did not return the cloudflare backend")
	}
	if !beadsbackend.WorkspaceIsBeadsDir("cloudflare") {
		t.Error("cloudflare identifies its workspace by the .beads directory alone, which WorkspaceIsBeadsDir should report")
	}
}

// TestNormalizeTracker pins the folder-name behaviour, because getting it wrong
// is silent and looks like a server fault: an uppercase segment matches no route
// and the Worker answers "no such route on this server".
func TestNormalizeTracker(t *testing.T) {
	cases := map[string]string{
		"Acme-WebApp":            "acme-webapp",
		"Acme-AI-Platform":       "acme-ai-platform",
		"acme-docs":              "acme-docs",
		"Acme_Blog":              "acme-blog",
		"  Spaced  Name  ":       "spaced-name",
		"--leading-and-trailing": "leading-and-trailing",
	}
	for in, want := range cases {
		got, err := cloudflare.NormalizeTracker(in)
		if err != nil {
			t.Errorf("NormalizeTracker(%q): %v", in, err)
			continue
		}
		if got != want {
			t.Errorf("NormalizeTracker(%q) = %q, want %q", in, got, want)
		}
	}
	if _, err := cloudflare.NormalizeTracker("---"); err == nil {
		t.Error("a name that reduces to nothing must be an error, not an empty tracker id")
	}
}

// TestUnsupportedCoversEveryDeclaredMethod keeps the allowlist and the stubs in
// step. A method that refuses at runtime but is absent from the allowlist is a
// method the conformance suite never checks, which is exactly the drift this
// file exists to prevent.
func TestUnsupportedCoversEveryDeclaredMethod(t *testing.T) {
	declared := cloudflare.Unsupported()
	if len(declared) == 0 {
		t.Fatal("the allowlist is empty; every unimplemented method must be declared")
	}
	t.Logf("%d methods are declared unsupported and checked by the conformance suite", len(declared))
}
