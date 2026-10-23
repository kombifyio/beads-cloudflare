package cloudflare

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/steveyegge/beads/backend"
	"github.com/steveyegge/beads/issueops"
)

// Problem is the profile's error envelope: the upstream /v0 Problem schema, with
// every typed extension member a role needs to rebuild the sentinel or typed
// error the in-tree store would have returned.
type Problem struct {
	Status          int    `json:"status"`
	Title           string `json:"title"`
	Code            string `json:"code"`
	Detail          string `json:"detail"`
	Param           string `json:"param"`
	Reason          string `json:"reason"`
	Outcome         string `json:"x_outcome"`
	MutationApplied *bool  `json:"x_mutation_applied"`

	ActualAssignee    *string `json:"actual_assignee"`
	ActualStatus      *string `json:"actual_status"`
	ActualVersion     *string `json:"actual_version"`
	Assignee          *string `json:"assignee"`
	BlockerID         *string `json:"blocker_id"`
	BlockerIsAncestor *bool   `json:"blocker_is_ancestor"`
	DeclaredLater     *bool   `json:"declared_later"`
	ExistingType      *string `json:"existing_type"`
	IssueID           *string `json:"issue_id"`
	IssueStatus       *string `json:"issue_status"`
	ItemIndex         *int    `json:"item_index"`
	ItemIssueID       *string `json:"item_issue_id"`
	ItemKey           *string `json:"item_key"`
	ItemKind          *string `json:"item_kind"`
	OpenChildren      *int    `json:"open_children"`
	RequestedType     *string `json:"requested_type"`
	RequestID         string  `json:"request_id"`

	retryAfter time.Duration
}

func (p *Problem) Error() string {
	if p.Param != "" {
		return fmt.Sprintf("%s (%s): %s", p.Code, p.Param, p.Detail)
	}
	return fmt.Sprintf("%s: %s", p.Code, p.Detail)
}

// Refused reports the structured refusal the platform requires for an operation
// the backend cannot perform, so callers get a denial rather than a fault.
func (p *Problem) Refused() bool {
	return p.Status >= 400 && p.Status < 500
}

// RejectedWithoutMutation is true only when the store confirmed that the write
// transaction rolled back. HTTP status alone cannot establish this after a lost acknowledgement.
func (p *Problem) RejectedWithoutMutation() bool {
	return p.Refused() && p.Outcome == "rejected" && p.MutationApplied != nil && !*p.MutationApplied
}

// apiError carries a Problem together with the Beads error the in-tree store
// would have produced for the same refusal. Both are reachable: errors.Is and
// errors.As find the sentinel or typed error, and errors.As finds the *Problem.
type apiError struct {
	problem *Problem
	mapped  error
}

func (e *apiError) Error() string {
	if e.mapped != nil {
		return e.mapped.Error()
	}
	return e.problem.Error()
}

func (e *apiError) Unwrap() []error {
	if e.mapped == nil {
		return []error{e.problem}
	}
	return []error{e.mapped, e.problem}
}

// translate maps a Problem onto the sentinels and typed errors Beads callers
// match with errors.Is and errors.As. It is the inverse of the upstream
// handlers' error classifier: a refusal the handler built from a sentinel comes
// back here as that sentinel. Without it a missing issue arrives as an opaque
// transport refusal and a caller cannot tell "no such issue" from "the store is
// broken".
func translate(err error) error {
	if err == nil {
		return nil
	}
	var p *Problem
	if !errors.As(err, &p) {
		return err
	}
	if _, wrapped := err.(*apiError); wrapped {
		return err
	}
	mapped := problemSentinel(p)
	if p.ItemIndex != nil {
		if p.DeclaredLater != nil {
			mapped = &issueops.RefError{Index: *p.ItemIndex, Member: p.Param, Key: str(p.ItemKey), DeclaredLater: *p.DeclaredLater}
		} else {
			inner := mapped
			if inner == nil {
				inner = p
			}
			mapped = &issueops.ItemError{
				Index: *p.ItemIndex, Kind: issueops.ItemKind(str(p.ItemKind)), Key: str(p.ItemKey),
				IssueID: str(p.ItemIssueID), Err: inner,
			}
		}
	}
	return &apiError{problem: p, mapped: mapped}
}

func asProblem(err error, target **Problem) bool { return errors.As(err, target) }

func str(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func versionOf(p *string) int64 {
	if p == nil {
		return 0
	}
	v, _ := strconv.ParseInt(*p, 10, 64)
	return v
}

func problemSentinel(p *Problem) error {
	detail := p.Detail
	switch {
	case p.Status == 404, p.Code == "not_found":
		return fmt.Errorf("%s: %w", detail, backend.ErrNotFound)
	case p.Code == "already_exists":
		return fmt.Errorf("%s: %w", detail, backend.ErrAlreadyExists)
	case p.Code == "already_claimed":
		holder := str(p.Assignee)
		inner := issueops.ErrAlreadyClaimed
		msg := error(inner)
		if holder != "" {
			msg = fmt.Errorf("%w by %s", inner, holder)
		}
		return &issueops.ClaimConflictError{IssueID: str(p.IssueID), Assignee: holder, Err: msg}
	case p.Code == "not_claimable":
		status := str(p.IssueStatus)
		msg := error(issueops.ErrNotClaimable)
		if status != "" {
			msg = fmt.Errorf("%w: status %s", issueops.ErrNotClaimable, status)
		}
		return &issueops.ClaimConflictError{IssueID: str(p.IssueID), Status: issueops.Status(status), Err: msg}
	case p.Code == "not_releasable":
		return fmt.Errorf("%s: %w", detail, issueops.ErrNotReleasable)
	case p.Code == "not_closable":
		if p.OpenChildren != nil {
			return &issueops.CloseOpenChildrenError{IssueID: str(p.IssueID), OpenChildren: *p.OpenChildren}
		}
		return fmt.Errorf("%s: %w", detail, issueops.ErrCloseBlocked)
	case p.Code == "dependency_cycle":
		if p.BlockerID != nil {
			return &issueops.DependencyHierarchyConflictError{
				IssueID: str(p.IssueID), BlockerID: str(p.BlockerID), BlockerIsAncestor: p.BlockerIsAncestor != nil && *p.BlockerIsAncestor,
			}
		}
		return fmt.Errorf("%s: %w", detail, issueops.ErrDependencyCycle)
	case p.Code == "dependency_exists":
		return &issueops.DependencyTypeConflictError{
			IssueID: str(p.IssueID), ExistingType: str(p.ExistingType), RequestedType: str(p.RequestedType),
		}
	case p.Code == "precondition_failed":
		switch {
		case p.ActualVersion != nil:
			return fmt.Errorf("%s: %w", detail, issueops.ErrVersionMismatch)
		case p.ActualStatus != nil:
			return fmt.Errorf("%s: %w", detail, issueops.ErrStatusMismatch)
		case p.ActualAssignee != nil:
			return fmt.Errorf("%s: %w", detail, issueops.ErrAssigneeMismatch)
		case p.Param == "expected_assignee":
			return fmt.Errorf("%s: %w", detail, issueops.ErrAssigneeMismatch)
		case p.Param == "expected_status":
			return fmt.Errorf("%s: %w", detail, issueops.ErrStatusMismatch)
		}
		return fmt.Errorf("%s: %w", detail, issueops.ErrVersionMismatch)
	case p.Code == "not_initialized":
		return fmt.Errorf("%s: %w", detail, backend.ErrNotInitialized)
	case p.Code == "invalid_argument" && strings.Contains(detail, "cannot depend on itself"):
		return fmt.Errorf("%s: %w: %w", detail, issueops.ErrSelfDependency, backend.ErrValidation)
	case p.Code == "invalid_argument" && p.Param == "id" && strings.Contains(detail, "configured issue prefix"):
		return fmt.Errorf("%s: %w: %w", detail, backend.ErrPrefixMismatch, backend.ErrValidation)
	case p.Code == "invalid_argument", p.Code == "invalid_cursor", p.Code == "validation_failed":
		return fmt.Errorf("%s: %w", detail, backend.ErrValidation)
	}
	return nil
}

// decodeProblem builds the error for a non-2xx response.
func decodeProblem(status int, payload []byte) error {
	p := &Problem{}
	if err := json.Unmarshal(payload, p); err != nil || p.Code == "" {
		return &Problem{Status: status, Code: "transport", Detail: trimmed(payload)}
	}
	p.Status = status
	return translate(p)
}

func trimmed(b []byte) string {
	const limit = 300
	s := string(b)
	for len(s) > 0 && (s[len(s)-1] == '\n' || s[len(s)-1] == ' ') {
		s = s[:len(s)-1]
	}
	if len(s) > limit {
		s = s[:limit] + "..."
	}
	return s
}

// isNotFound matches through the translation the client applies, so a sentinel
// from the Worker is still recognisable once it has been wrapped.
func isNotFound(err error) bool {
	if errors.Is(err, backend.ErrNotFound) {
		return true
	}
	var p *Problem
	return errors.As(err, &p) && p.Status == 404
}

// withIssue fills the issue id a typed refusal could not carry on the wire.
func withIssue(err error, id string) error {
	var open *issueops.CloseOpenChildrenError
	if errors.As(err, &open) && open.IssueID == "" {
		open.IssueID = id
	}
	var claim *issueops.ClaimConflictError
	if errors.As(err, &claim) && claim.IssueID == "" {
		claim.IssueID = id
	}
	return err
}
