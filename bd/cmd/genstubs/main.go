// Command genstubs generates cloudflare/stubs.go and the unsupported allowlists
// from the real Beads interface, by reflection on the pinned Beads version.
//
// The methods it emits are the ones the Cloudflare /v0 profile does not serve.
// Generating them from the interface rather than writing them by hand is what
// keeps the file honest: a Beads upgrade that adds a required method produces a
// compile error here rather than a silent gap at runtime.
//
//	go run ./cmd/genstubs ./cloudflare/stubs.go
package main

import (
	"bytes"
	"fmt"
	"go/format"
	"os"
	"reflect"
	"strings"

	"github.com/steveyegge/beads/backend"
)

// backendName is what the refusal names, so a caller can tell which backend said no.
const backendName = "cloudflare"

// implemented lists the methods store.go writes by hand; genstubs must not emit them.
var implemented = map[string]bool{
	"AddComment": true, "AddDependency": true, "AddDependencyWithOptions": true,
	"AddIssueComment": true, "ClaimIssue": true, "Close": true, "CloseIssue": true,
	"CloseIssueChecked": true, "CountDependencies": true, "CountDependents": true,
	"CountEvents": true, "CountIssueComments": true, "CountIssues": true,
	"CountReadyWork": true, "CreateIssue": true, "CreateIssues": true,
	"DeleteIssue": true, "EventsSince": true, "GetAllDependencyRecords": true,
	"GetAllEventsSince": true, "GetBlockedIssues": true, "GetCommentCounts": true,
	"GetCommentsForIssues": true, "GetConfig": true, "GetDependencies": true,
	"GetDependencyCounts": true, "GetDependencyRecords": true,
	"GetDependencyRecordsForIssues": true, "GetDependents": true, "GetIssue": true,
	"GetReadyWork": true, "GetStatistics": true, "IterIssues": true,
	"IterReadyWork": true, "ReleaseIssue": true, "RemoveDependency": true,
	"ReopenIssue": true, "UpdateIssue": true, "UpdateIssueChecked": true,
	"AddLabel": true, "ClaimReadyIssue": true, "GetMemories": true, "GetMemory": true,
	"Remember": true, "Forget": true, "Path": true, "CLIDir": true, "Database": true,
	"Backend": true, "Active": true, "IsReadOnly": true, "ListIssues": true,
	// Profile-served reads and writes that store.go maps onto the /v0 contract.
	"GetIssuesByIDs": true, "GetIssueByExternalRef": true, "GetEvents": true,
	"CountIssuesByGroup": true, "UpdateIssueType": true, "UnclaimIssue": true,
	"UnclaimIssueIfAssignee": true, "SearchIssues": true, "SearchIssueIDs": true, "RemoveLabel": true, "GetReadyWorkWithCounts": true,
	// Label and comment reads: getIssue already carries both, so these are reads
	// of what the profile serves rather than new endpoints.
	"GetLabels": true, "GetLabelsForIssues": true, "GetIssuesByLabel": true,
	"GetIssueComments": true,
	// The lease pair, over the profile's heartbeat and reclaim verbs.
	"HeartbeatIssue": true, "ReclaimExpiredLeases": true,
	// The durable settings plane, with its normalized vocabulary projections.
	"SetConfig": true, "GetAllConfig": true, "DeleteConfig": true,
	"GetCustomStatuses": true, "GetCustomStatusesDetailed": true, "GetCustomTypes": true,
	"GetInfraTypes": true, "IsInfraTypeCtx": true,
	// The role accessors: each returns a role implemented in roles_*.go over the
	// route the upstream handler of the same role serves.
	"IssueLifecycle": true, "IssueReader": true, "IssueClaimer": true, "ReadyClaimer": true,
	"BatchCloser": true, "BatchCreator": true, "DependencyEditor": true, "Commenter": true,
	"Counter": true, "StatsReporter": true, "IssueRelations": true, "WorkspaceConfig": true,
	"Memories": true, "VersionReconciler": true, "CycleDetector": true, "EdgeReader": true,
	"BlockingAnnotator": true, "TreeWalker": true, "GraphCounter": true, "ReadyCounter": true,
	"Querier": true, "Sweeper": true, "Deleter": true, "InitVerifier": true, "MetadataCAS": true,
	"BatchApplier": true, "Releaser": true,
	// Clone-local state, kept in a file under the workspace .beads directory.
	"SetLocalMetadata": true, "GetLocalMetadata": true, "GetMetadata": true, "SetMetadata": true,
	"GetRepoMtime": true, "SetRepoMtime": true, "ClearRepoMtime": true,
	// Version control has no meaning for a remote store; Commit answers "nothing
	// to commit" so the post-command auto-commit is a no-op rather than a failure.
	"Commit": true, "History": true, "MergeMetadata": true, "SlotSet": true, "SlotGet": true, "SlotClear": true,
	// Reads and counts over the roles, in store_raw.go.
	"IterBlockedIssues": true, "IsBlocked": true, "IsBlockedBatch": true, "GetBlockingInfoForIssues": true,
	"GetNewlyUnblockedByClose": true, "GetDependenciesWithMetadata": true, "GetDependentsWithMetadata": true,
	"IterDependenciesWithMetadata": true, "IterDependentsWithMetadata": true, "GetDependencyTree": true,
	"DetectCycles": true, "GetEpicsEligibleForClosure": true, "GetNextChildID": true, "GetStaleIssues": true,
	"GetIssueCommentsPage": true, "IterIssueComments": true, "IterEvents": true, "IterAllEventsSince": true,
	"SearchIssuesWithCounts": true, "RunInTransaction": true, "RemoveDependencyWithOptions": true, "CreateIssuesWithFullOptions": true, "RunInIssueLifecycleTransaction": true,
	"GetDependentRecords": true, "GetDependentRecordsForIssues": true,
}

// versionControlFamilies are the seven capability families the conformance
// package never calls: a backend DECLARES them with a typed ErrUnsupported
// rather than implementing them.
var versionControlFamilies = map[string]bool{
	"Branch": true, "Checkout": true, "Commit": true, "CommitAll": true,
	"CommitExists": true, "CommitMergeResolution": true, "CommitPending": true,
	"CommitWithConfig": true, "CurrentBranch": true, "DeleteBranch": true,
	"GetConflicts": true, "GetCurrentCommit": true, "ListBranches": true, "Log": true,
	"Merge": true, "ResolveConflicts": true, "Status": true,
	"AsOf": true, "Diff": true,
	"AddRemote": true, "AddRemoteWithRef": true, "Fetch": true, "ForcePush": true,
	"HasRemote": true, "ListRemotes": true, "Pull": true, "PullFrom": true,
	"PullRemote": true, "Push": true, "PushRemote": true, "PushTo": true,
	"RemoveRemote": true, "Sync": true, "SyncStatus": true,
	"AddFederationPeer": true, "GetFederationPeer": true, "ListFederationPeers": true,
	"RemoveFederationPeer": true, "ApplyCompaction": true, "CheckEligibility": true,
	"GetCompactionSnapshot": true, "GetTier1Candidates": true, "GetTier2Candidates": true,
	"RestoreFromSnapshot": true, "SnapshotIssue": true, "GetStatisticsNoBlocked": true,
}

const (
	reasonVersionControl = "the Cloudflare store serves the tracker over HTTPS; it has no version-control, history, remote, sync, federation, compaction or fast-statistics surface"
	reasonNotInProfile   = "the /v0 profile served by kombifyio/beads-cloudflare does not implement this operation"
)

func isBuiltin(name string) bool {
	switch name {
	case "string", "bool", "int", "int8", "int16", "int32", "int64",
		"uint", "uint8", "uint16", "uint32", "uint64", "uint32ptr", "float32",
		"float64", "byte", "rune", "error", "any":
		return true
	}
	return false
}

// qualify renders a type as source that compiles in this module. Beads domain
// types are reached through the backend package's aliases, which is what that
// package exists to provide; stdlib and public Beads packages keep their own
// import; Iter is aliased as a generic.
func qualify(t reflect.Type) string {
	s := t.String()
	// On a toolchain where json.RawMessage is an alias of jsontext.Value the
	// reflected name is the jsontext one; json.RawMessage is the same type there
	// and the only one that exists on the toolchain upstream pins.
	if s == "jsontext.Value" {
		return "json.RawMessage"
	}
	// storage.Status is the version-control status, not the issue status; the
	// backend package re-exports it under an unambiguous name.
	if s == "storage.Status" {
		return "backend.VCStatus"
	}
	if strings.HasPrefix(s, "storage.Status.") || strings.HasPrefix(s, "*storage.Status") {
		return strings.Replace(s, "storage.Status", "backend.VCStatus", 1)
	}
	// A generic renders with its defining package, e.g.
	// storage.Iter[github.com/steveyegge/beads/internal/types.Dependency]. Its
	// arguments are parsed out of the rendering rather than reflected: an
	// instantiated generic from another package has no usable reflect.Type.Elem.
	for _, head := range []string{"SliceIter[", "Iter["} {
		if i := strings.Index(s, head); i >= 0 && strings.HasSuffix(s, "]") && isWordBoundary(s[:i]) {
			// head already carries the opening bracket.
			inner := s[i+len(head) : len(s)-1]
			return "backend." + head + qualifyTypeName(inner) + "]"
		}
	}
	switch {
	case s == "context.Context", strings.HasPrefix(s, "time."),
		strings.HasPrefix(s, "json."), strings.HasPrefix(s, "issueops."),
		strings.HasPrefix(s, "memoryops."), strings.HasPrefix(s, "journalops."),
		strings.HasPrefix(s, "backend."), strings.HasPrefix(s, "encoding/json"):
		return s
	}
	switch t.Kind() {
	case reflect.Func:
		in := make([]string, t.NumIn())
		for i := range in {
			in[i] = qualify(t.In(i))
		}
		out := make([]string, t.NumOut())
		for i := range out {
			out[i] = qualify(t.Out(i))
		}
		switch len(out) {
		case 0:
			return "func(" + strings.Join(in, ", ") + ")"
		case 1:
			return "func(" + strings.Join(in, ", ") + ") " + out[0]
		default:
			return "func(" + strings.Join(in, ", ") + ") (" + strings.Join(out, ", ") + ")"
		}
	case reflect.Chan:
		return "chan " + qualify(t.Elem())
	case reflect.Ptr:
		return "*" + qualify(t.Elem())
	case reflect.Slice:
		return "[]" + qualify(t.Elem())
	case reflect.Array:
		return fmt.Sprintf("[%d]%s", t.Len(), qualify(t.Elem()))
	case reflect.Map:
		return "map[" + qualify(t.Key()) + "]" + qualify(t.Elem())
	}
	// A named Beads type renders with its defining package path. Strip the
	// module prefix and keep the last element, which the backend package aliases.
	if i := strings.LastIndexByte(s, '.'); i > 0 && !isBuiltin(s[i+1:]) {
		return "backend." + s[i+1:]
	}
	return s
}

// isWordBoundary reports whether the text before a match ends a Go identifier,
// so "Iter[" inside "SliceIter[" is not mistaken for the shorter head.
func isWordBoundary(prefix string) bool {
	if prefix == "" {
		return true
	}
	c := prefix[len(prefix)-1]
	return !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_')
}

// qualifyTypeName qualifies one rendered type name, which for a generic argument
// is the last path element of the fully qualified form.
func qualifyTypeName(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.LastIndexByte(s, '.'); i > 0 && !isBuiltin(s[i+1:]) {
		return "backend." + s[i+1:]
	}
	return s
}

// paramName names a parameter. Most methods take a context as the first
// parameter; the federation and version-control families do not, so the name is
// decided by the actual type rather than by position.
func paramName(method string, t reflect.Type, ordinal int) string {
	if t.String() == "context.Context" {
		return "ctx"
	}
	base := strings.ToLower(method[:1]) + method[1:]
	if ordinal == 1 {
		return base
	}
	return fmt.Sprintf("%s%d", base, ordinal)
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: genstubs <output.go>")
		os.Exit(2)
	}
	doltStorage := reflect.TypeOf((*backend.DoltStorage)(nil)).Elem()
	var body bytes.Buffer
	var versionControl, notInProfile []string

	for i := 0; i < doltStorage.NumMethod(); i++ {
		method := doltStorage.Method(i)
		if implemented[method.Name] {
			continue
		}
		fn := method.Type
		var params, blanks []string
		ordinal := 0
		for j := 0; j < fn.NumIn(); j++ {
			ordinal++
			name := paramName(method.Name, fn.In(j), ordinal)
			params = append(params, name+" "+qualify(fn.In(j)))
			blanks = append(blanks, name)
		}
		results := make([]string, 0, fn.NumOut())
		resultTypes := make([]reflect.Type, 0, fn.NumOut())
		for j := 0; j < fn.NumOut(); j++ {
			results = append(results, qualify(fn.Out(j)))
			resultTypes = append(resultTypes, fn.Out(j))
		}
		refusalExpr := refusal(resultTypes, method.Name)
		if versionControlFamilies[method.Name] {
			versionControl = append(versionControl, method.Name)
		} else {
			notInProfile = append(notInProfile, method.Name)
		}

		// A trailing error is part of the method's own signature, so the
		// signature is written from the result types rather than assumed.
		fmt.Fprintf(&body, "func (s *Store) %s(%s) ", method.Name, strings.Join(params, ", "))
		switch {
		case len(results) == 0:
			body.WriteString("{")
		case len(results) == 1:
			fmt.Fprintf(&body, "%s {", results[0])
		default:
			fmt.Fprintf(&body, "(%s) {", strings.Join(results, ", "))
		}
		body.WriteString("\n")
		// One blank per parameter: `_, _ = a` is a two-value assignment.
		for _, b := range blanks {
			fmt.Fprintf(&body, "\t_ = %s\n", b)
		}
		if strings.HasPrefix(refusalExpr, "panic(") {
			fmt.Fprintf(&body, "\t%s\n}\n\n", refusalExpr)
		} else {
			fmt.Fprintf(&body, "\treturn %s\n}\n\n", refusalExpr)
		}
	}

	source := importsFor(body.String()) + body.String()
	formatted, err := format.Source([]byte(source))
	if err != nil {
		fmt.Fprintln(os.Stderr, "format:", err)
		_ = os.WriteFile(os.Args[1]+".raw", []byte(source), 0o644)
		os.Exit(1)
	}
	if err := os.WriteFile(os.Args[1], formatted, 0o644); err != nil {
		panic(err)
	}
	writeAllowlists(versionControl, notInProfile)
	fmt.Printf("stubs: %d of %d methods (%d version-control, %d outside the profile)\n",
		len(versionControl)+len(notInProfile), doltStorage.NumMethod(), len(versionControl), len(notInProfile))
}

// zeroLiteral renders the zero value of t as source. The backend package offers
// no generic zero[T] to index, so the literal is emitted directly.
func zeroLiteral(t reflect.Type) string {
	switch t.Kind() {
	case reflect.Bool:
		return "false"
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return "0"
	case reflect.Float32, reflect.Float64:
		return "0"
	case reflect.String:
		return `""`
	default:
		return "nil"
	}
}

func refusal(resultTypes []reflect.Type, method string) string {
	refusal := fmt.Sprintf("&backend.ErrUnsupported{Op: %q, Backend: backendName}", method)
	if len(resultTypes) > 0 && !isError(resultTypes[len(resultTypes)-1]) {
		// No error slot to return the refusal in. A typed panic is the only honest
		// signal left: returning a zero value would let the caller read it as a real
		// answer. Such a method cannot go on the allowlist either, because the
		// conformance suite can only assert the contract for methods that return an
		// error, so noAllowlist collects them.
		noAllowlist[method] = true
		return "panic(" + refusal + ")"
	}
	// The error, when the method returns one, IS the refusal: zero everything
	// before it and hand the refusal back in its place.
	values := resultTypes
	if isError(resultTypes[len(resultTypes)-1]) {
		values = resultTypes[:len(resultTypes)-1]
	}
	parts := make([]string, 0, len(values)+1)
	for _, t := range values {
		parts = append(parts, zeroLiteral(t))
	}
	return strings.Join(append(parts, refusal), ", ")
}

// noAllowlist holds the unsupported methods that have no error return.
var noAllowlist = map[string]bool{}

func isError(t reflect.Type) bool {
	return t.Kind() == reflect.Interface && t.String() == "error"
}

func writeAllowlists(versionControl, notInProfile []string) {
	write := func(path string, names []string, reason string) {
		var b strings.Builder
		for _, n := range names {
			if noAllowlist[n] {
				continue
			}
			fmt.Fprintf(&b, "\t\t%q: %q,\n", n, reason)
		}
		if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
			panic(err)
		}
	}
	write("cloudflare/allowlist_versioncontrol.txt", versionControl, reasonVersionControl)
	write("cloudflare/allowlist_profile.txt", notInProfile, reasonNotInProfile)
}

// importsFor renders the package clause from what the body actually uses, so the
// generated file compiles whether or not any method happens to take a context.
func importsFor(body string) string {
	var b strings.Builder
	b.WriteString("package cloudflare\n\nimport (\n")
	for _, imp := range []struct{ path, alias string }{
		{"context", "context"}, {"time", "time"},
		{"encoding/json", "json"},
		{"github.com/steveyegge/beads/backend", "backend"},
		{"github.com/steveyegge/beads/issueops", "issueops"},
		{"github.com/steveyegge/beads/memoryops", "memoryops"},
		{"github.com/steveyegge/beads/journalops", "journalops"},
	} {
		if !strings.Contains(body, imp.alias+".") {
			continue
		}
		if imp.path == imp.alias {
			fmt.Fprintf(&b, "\t%q\n", imp.path)
			continue
		}
		fmt.Fprintf(&b, "\t%s %q\n", imp.alias, imp.path)
	}
	b.WriteString(")\n\n")
	b.WriteString(docComment)
	return b.String()
}

const docComment = `// Code generated by cmd/genstubs. DO NOT EDIT.
//
// Every method below answers a typed ErrUnsupported. Each is a capability the
// Worker does not serve, not a gap in the translation: the /v0 profile is a
// declared subset of the upstream contract, so a caller that reaches one of
// these gets a refusal it can act on instead of a subtly wrong answer.
//
// backendName names this backend in every refusal, so a caller holding only the
// error can tell which backend said no.
const backendName = "cloudflare"

// The reasons live in the allowlists in convert.go, which is what the upstream
// conformance suite walks. Keep this file and those maps together: a method here
// without a map entry is a method the suite never checks.

`
