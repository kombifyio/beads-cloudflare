#!/usr/bin/env bash
# Pair proof against an explicitly admitted live Worker and finite shared-test pool.
#
#   node scripts/pair-proof-live.mjs
#
# It builds this tree's native client, checks the admitted live Worker version/source,
# and runs smoke and profile-adjusted upstream conformance in the provisioner's test pool.
# Completed Go JSON results allow only the eight named profile deviations. A fix
# cannot compensate for a new failure elsewhere; process errors fail closed.
#
# Environment (all optional):
#   UPSTREAM_TAG     upstream beads tag to build against (default: the version bd/go.mod pins)
#   UPSTREAM_REPO    git URL or path of upstream beads (default: github gastownhall/beads)
#   UPSTREAM_CACHE   directory that keeps a shallow clone of the upstream tag between runs
#   BD               a prebuilt bd to test instead of building one
#   KEEP_WORK=1      keep the scratch directory (logs, state) after the run
#
# No local database or Worker is started. The wrapper owns fixture/key cleanup.
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT" || exit 2
VERSION=$(tr -d '[:space:]' <VERSION)
PINNED_UPSTREAM_TAG=$(sed -n 's/^- Tag: //p' spec/upstream/SOURCE.md | tr -d '\r')
[ -z "${UPSTREAM_TAG:-}" ] || [ "$UPSTREAM_TAG" = "$PINNED_UPSTREAM_TAG" ] || { echo "pair-proof: upstream must match the declared source pin" >&2; exit 2; }
UPSTREAM_TAG="$PINNED_UPSTREAM_TAG"
[ -n "$UPSTREAM_TAG" ] || { echo "pair-proof: cannot read the pinned upstream version from bd/go.mod" >&2; exit 2; }

EXE=""; case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) EXE=".exe" ;; esac
WORK=$(mktemp -d)
cleanup() {
  if [ "${KEEP_WORK:-}" = 1 ]; then echo "pair-proof: scratch kept in $WORK"; else rm -rf "$WORK" 2>/dev/null || true; fi
}
trap cleanup EXIT
fail() { echo "::error::pair-proof: $*" >&2; echo "pair-proof FAILED: $*" >&2; exit 1; }
json() { node -e "const v=JSON.parse(require('fs').readFileSync(0,'utf8'));const r=($1);process.stdout.write(r===undefined?'':String(r))"; }

# ---- 1. bd, built from this tree
BD=${BD:-}
if [ -z "$BD" ]; then
  if [ -n "${UPSTREAM_CACHE:-}" ]; then
    if [ ! -d "$UPSTREAM_CACHE/.git" ]; then
      git clone --quiet --depth 1 --branch "$UPSTREAM_TAG" "${UPSTREAM_REPO:-https://github.com/gastownhall/beads.git}" "$UPSTREAM_CACHE" || fail "cannot clone upstream $UPSTREAM_TAG into $UPSTREAM_CACHE"
    fi
    export UPSTREAM_REPO="file://$UPSTREAM_CACHE"
  fi
  echo "== build bd (upstream $UPSTREAM_TAG + bd/ module, VERSION $VERSION)"
  BD="$WORK/bd$EXE"
  bash scripts/build-bd.sh "$UPSTREAM_TAG" "$BD" || fail "scripts/build-bd.sh failed"
fi
reported=$("$BD" --version 2>&1 | head -1)
echo "bd reports: $reported"
case "$reported" in *"+cloudflare.$VERSION"*) ;; *) fail "bd does not carry the version stamp +cloudflare.$VERSION (VERSION file)";; esac

# ---- 2. the explicitly admitted live Worker and shared test identity
: "${BEADS_CLOUDFLARE_BASE:?run scripts/pair-proof-live.mjs with a live store}"
: "${BEADS_CLOUDFLARE_TOKEN:?missing scoped shared test identity}"
: "${PAIR_TEST_POOL:?missing finite shared test tracker pool}"
: "${PAIR_WORKER_SOURCE_SHA:?missing exact Worker source SHA}"
BASE="$BEADS_CLOUDFLARE_BASE"
KEY="$BEADS_CLOUDFLARE_TOKEN"
HANDSHAKE=$(printf '%s' "$PAIR_TEST_POOL" | json 'v[0]')
SMOKE_TRACKER=$(printf '%s' "$PAIR_TEST_POOL" | json 'v[1]')
context=$(curl -fsS "$BASE/t/$HANDSHAKE/v0/beads/context" -H "Authorization: Bearer $KEY") || fail "cannot read the admitted live store context"
store_version=$(printf '%s' "$context" | json 'v.x_store_version')
store_sha=$(printf '%s' "$context" | json 'v.x_source_sha')
[ "$store_version" = "$VERSION" ] || fail "the live Worker version does not match VERSION"
[ "$store_sha" = "$PAIR_WORKER_SOURCE_SHA" ] || fail "the live Worker source does not match the admitted SHA"
echo "live store and bd are both $VERSION, Worker source $store_sha"

# ---- 4. the smoke script, on a fresh tracker
echo "== smoke"
BD="$BD" TRACKER="$SMOKE_TRACKER" SMOKE_ALLOW_REMOTE=1 bash scripts/smoke.sh || fail "the smoke script failed"

# ---- 5. the upstream live conformance suite, on fresh trackers, against the baseline
echo "== profile-adjusted upstream conformance suite (two-hour lease; three-hour reclaim fixtures)"
native() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
fixture_cache=()
if [ -n "${UPSTREAM_CACHE:-}" ]; then fixture_cache=("$(native "$UPSTREAM_CACHE")"); fi
node scripts/prepare-conformance-fixtures.mjs "$(native "$WORK")" "${fixture_cache[@]}" || fail "conformance fixture qualification failed"
report="$WORK/conformance.jsonl"
(
  cd bd || exit 2
  BEADS_CLOUDFLARE_LIVE=1 BEADS_CLOUDFLARE_TRACKER="$HANDSHAKE" \
    go test -modfile="$(native "$WORK/conformance-fixtures/conformance.mod")" ./cloudflare/ -run '^TestLiveConformance$' -count=1 -timeout 20m -json >"$report" 2>"$WORK/conformance.stderr"
)
conformance_exit=$?
node scripts/conformance-result.mjs "$report" "$conformance_exit" || fail "conformance results were not admitted"
echo "PASS: pair proof (bd $reported, store $store_version, completed named profile-adjusted conformance results)"
