#!/usr/bin/env bash
# The pair proof: this tree's Worker and this tree's bd work together, on a machine with
# nothing but the repository, Node, pnpm, Go and git.
#
#   bash scripts/pair-proof.sh
#
# It builds bd from the tree (upstream beads plus the bd/ module), starts the Worker
# locally with workerd (wrangler dev on a free port, fresh state, 127.0.0.1 only), mints
# an agent key, checks that both sides report the same version, then runs the smoke
# script and the upstream live conformance suite against the Worker on fresh trackers.
# The conformance result is held to a baseline: the gate fails when it gets worse, or when
# fewer than MIN_TOTAL checks ran (an aborted run proves nothing).
#
# Environment (all optional):
#   UPSTREAM_TAG     upstream beads tag to build against (default: the version bd/go.mod pins)
#   UPSTREAM_REPO    git URL or path of upstream beads (default: github gastownhall/beads)
#   UPSTREAM_CACHE   directory that keeps a shallow clone of the upstream tag between runs
#   BD               a prebuilt bd to test instead of building one
#   BASELINE_PASS    conformance checks that must pass at least (default 52)
#   BASELINE_FAIL    conformance checks that may fail at most (default 8)
#   MIN_TOTAL        checks that must have run (default 60)
#   KEEP_WORK=1      keep the scratch directory (logs, state) after the run
#
# The Worker's state lives in a scratch directory and the port is free, so a developer's
# own `wrangler dev` instance is never touched.
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT" || exit 2
VERSION=$(tr -d '[:space:]' <VERSION)
UPSTREAM_TAG=${UPSTREAM_TAG:-$(sed -n 's#^require github.com/steveyegge/beads \(v[0-9.]*\)$#\1#p' bd/go.mod | head -1)}
BASELINE_PASS=${BASELINE_PASS:-52}
BASELINE_FAIL=${BASELINE_FAIL:-8}
MIN_TOTAL=${MIN_TOTAL:-60}
[ -n "$UPSTREAM_TAG" ] || { echo "pair-proof: cannot read the pinned upstream version from bd/go.mod" >&2; exit 2; }

EXE=""; case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) EXE=".exe" ;; esac
WORK=$(mktemp -d)
WRANGLER_PID=""

kill_tree() {
  [ -n "$1" ] || return 0
  if [ -n "$EXE" ]; then
    local winpid; winpid=$(cat "/proc/$1/winpid" 2>/dev/null || echo "$1")
    taskkill //F //T //PID "$winpid" >/dev/null 2>&1 || true
  else
    pkill -TERM -P "$1" 2>/dev/null || true
    kill "$1" 2>/dev/null || true
  fi
}
cleanup() {
  kill_tree "$WRANGLER_PID"
  if [ "${KEEP_WORK:-}" = 1 ]; then echo "pair-proof: scratch kept in $WORK"; else rm -rf "$WORK" 2>/dev/null || true; fi
}
trap cleanup EXIT
fail() { echo "::error::pair-proof: $*" >&2; echo "pair-proof FAILED: $*" >&2; [ -f "$WORK/wrangler.log" ] && { echo "--- Worker log (tail)"; tail -n 30 "$WORK/wrangler.log"; }; exit 1; }
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

# ---- 2. the Worker, locally
PORT=$(node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
BASE="http://127.0.0.1:$PORT"
ADMIN_TOKEN=$(node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))")
COOKIE_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
echo "== start the Worker on $BASE (fresh state in a scratch directory)"
CI=1 WRANGLER_SEND_METRICS=false node "$ROOT/node_modules/wrangler/bin/wrangler.js" dev \
  --ip 127.0.0.1 --port "$PORT" --persist-to "$WORK/state" \
  --var "PUBLIC_ORIGIN:$BASE" --var "ADMIN_TOKEN:$ADMIN_TOKEN" --var "COOKIE_ENCRYPTION_KEY:$COOKIE_KEY" \
  >"$WORK/wrangler.log" 2>&1 &
WRANGLER_PID=$!
for i in $(seq 1 90); do
  if curl -fsS "$BASE/healthz" >/dev/null 2>&1; then break; fi
  kill -0 "$WRANGLER_PID" 2>/dev/null || fail "the Worker exited during startup"
  sleep 1
  [ "$i" = 90 ] && fail "the Worker did not answer /healthz within 90 s"
done

# ---- 3. an agent key, and the version handshake
KEY=$(curl -fsS -X POST "$BASE/admin/keys" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"label":"pair-proof","scopes":["beads:read","beads:write","beads:import"]}' | json 'v.key') || fail "cannot mint an agent key"
[ -n "$KEY" ] || fail "the admin route returned no key"
export BEADS_CLOUDFLARE_BASE="$BASE" BEADS_CLOUDFLARE_TOKEN="$KEY"
context=$(curl -fsS "$BASE/t/pair-handshake/v0/beads/context" -H "Authorization: Bearer $KEY") || fail "cannot read the store context"
store_version=$(printf '%s' "$context" | json 'v.x_store_version')
[ "$store_version" = "$VERSION" ] || fail "the Worker reports version '$store_version' but VERSION is $VERSION (run node scripts/sync-version.mjs)"
echo "store and bd are both $VERSION"

# ---- 4. the smoke script, on a fresh tracker
echo "== smoke"
BD="$BD" bash scripts/smoke.sh || fail "the smoke script failed"

# ---- 5. the upstream live conformance suite, on fresh trackers, against the baseline
echo "== upstream conformance suite"
report="$WORK/conformance.txt"
(
  cd bd || exit 2
  BEADS_CLOUDFLARE_LIVE=1 BEADS_CLOUDFLARE_TRACKER="pair-$(date +%s)-$RANDOM" \
    go test ./cloudflare/ -run TestLiveConformance -timeout 20m -v 2>&1 | tee "$report" >/dev/null
)
passed=$(grep -c '^    --- PASS' "$report" || true)
failed=$(grep -c '^    --- FAIL' "$report" || true)
total=$((passed + failed))
echo "live conformance: $passed passed, $failed failed (baseline $BASELINE_PASS pass / $BASELINE_FAIL fail, $MIN_TOTAL checks)"
if [ "$total" -lt "$MIN_TOTAL" ]; then
  tail -n 40 "$report"
  fail "the suite reported only $total checks; it has $MIN_TOTAL, so the run aborted part way and the counts mean nothing"
fi
if [ "$passed" -lt "$BASELINE_PASS" ] || [ "$failed" -gt "$BASELINE_FAIL" ]; then
  grep '^    --- FAIL' "$report" | head -20
  fail "conformance regressed against the recorded baseline ($BASELINE_PASS pass / $BASELINE_FAIL fail): now $passed pass / $failed fail"
fi
echo "PASS: pair proof (bd $reported, store $store_version, conformance $passed/$total)"
