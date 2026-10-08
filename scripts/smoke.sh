#!/usr/bin/env bash
# Everyday bd commands against a Cloudflare store, end to end, on a fresh tracker.
# Fails on the first non-zero exit or missing effect.
#
#   BD=/path/to/bd BEADS_CLOUDFLARE_BASE=http://127.0.0.1:8788 \
#   BEADS_CLOUDFLARE_TOKEN=... scripts/smoke.sh
#
# Never point it at a store whose data you want to keep: it writes. A non-local
# base needs SMOKE_ALLOW_REMOTE=1.
set -uo pipefail

BD=${BD:?set BD to the combined bd binary}
BASE=${BEADS_CLOUDFLARE_BASE:?set BEADS_CLOUDFLARE_BASE}
: "${BEADS_CLOUDFLARE_TOKEN:?set BEADS_CLOUDFLARE_TOKEN}"
# The script writes, so it runs against a local or scratch store only. A remote
# base has to be named explicitly with SMOKE_ALLOW_REMOTE=1.
case "$BASE" in
  http://127.0.0.1[:/]*|http://localhost[:/]*|http://[[]::1[]][:/]*) ;;
  *) [ "${SMOKE_ALLOW_REMOTE:-}" = 1 ] || { echo "refusing to run against $BASE; set SMOKE_ALLOW_REMOTE=1 for a scratch store that is not local" >&2; exit 2; } ;;
esac

TRACKER=${TRACKER:-smoke-$(date +%s)-$RANDOM}
WS=$(mktemp -d)
trap 'rm -rf "$WS"' EXIT
mkdir -p "$WS/.beads"
printf '{"backend":"cloudflare"}' >"$WS/.beads/metadata.json"
printf '{"tracker":"%s","base":"%s","token_env":"BEADS_CLOUDFLARE_TOKEN"}' "$TRACKER" "$BASE" >"$WS/.beads/cloudflare.json"
cd "$WS" || exit 2
export BEADS_ACTOR=smoke-actor BD_NO_UPDATE_CHECK=1

n=0
OUT=
run() { # run <bd args...>: sets OUT, fails on a non-zero exit
  n=$((n + 1))
  OUT=$("$BD" "$@" 2>&1); rc=$?
  if [ $rc -ne 0 ]; then echo "FAIL #$n: bd $* (exit $rc)"; echo "$OUT"; exit 1; fi
  echo "ok   #$n: bd $*"
}
has() { case "$OUT" in *"$1"*) ;; *) echo "FAIL #$n: output lacks '$1'"; echo "$OUT"; exit 1;; esac; }
lacks() { case "$OUT" in *"$1"*) echo "FAIL #$n: output has '$1'"; echo "$OUT"; exit 1;; esac; }
idof() { printf '%s' "$OUT" | grep -o '"id": *"[^"]*"' | head -1 | sed 's/.*: *"\(.*\)"/\1/'; }

# --- create, show
run create "Alpha task" -t task -p 1 -l alpha -d "alpha body" --assignee smoke-actor --json
A=$(idof); [ -n "$A" ] || { echo "FAIL: no id from create"; echo "$OUT"; exit 1; }
printf 'line from a file\n' >body.txt
run create "Beta from file" -t bug -p 2 --body-file body.txt --parent "$A" --json
B=$(idof)
run create "Gamma blocked" -t task -p 3 --deps "$A" --json
C=$(idof)
run show "$A"; has "Alpha task"; has alpha
run show "$A" --json; has '"title": "Alpha task"'; has '"assignee": "smoke-actor"'
run show "$B"; has "line from a file"

# --- update, claim, labels
run update "$A" --priority 0 --add-label beta --remove-label alpha --title "Alpha renamed"
run show "$A" --json; has "Alpha renamed"; has beta; lacks '"alpha"'
D_OUT=$("$BD" create "Delta claim" -t task -p 2 --json 2>&1); OUT=$D_OUT; D=$(idof)
run update "$D" --claim; run show "$D" --json; has smoke-actor; has in_progress
# the claimant may clear its own assignment without a force
run update "$D" --assignee ""; run show "$D" --json; lacks '"assignee"'
# an invalid patch beside a claim is refused before the claim: nothing is left claimed
E_OUT=$("$BD" create "Epsilon unclaimed" -t task -p 2 --json 2>&1); OUT=$E_OUT; E=$(idof)
n=$((n + 1)); if "$BD" update "$E" --claim --metadata '[]' >/dev/null 2>&1; then echo "FAIL #$n: update --claim --metadata '[]' exited 0"; exit 1; fi
run show "$E" --json; lacks in_progress
run label add "$D" lbl1; run label list "$D"; has lbl1
run label remove "$D" lbl1; run label list "$D"; lacks lbl1

# --- list family
run list; has "Alpha renamed"; has "Gamma blocked"
run list --label beta; has "Alpha renamed"; lacks "Gamma blocked"
run list --parent "$A"; has "Beta from file"
run list --json --limit 2; has '"id"'
run list --all --sort priority; has "Alpha renamed"
run children "$A"; has "Beta from file"
run search Gamma; has "Gamma blocked"
run count; run count --json
run stats; run status
run query "priority<=1"; has "Alpha renamed"
run stale --days 1

# --- readiness and blocking
run ready; has "Alpha renamed"; lacks "Gamma blocked"
run blocked; has "Gamma blocked"
run dep list "$C"; has "$A"
run dep tree "$C"
run dep cycles
run close "$B" -r "child done"
run close "$A" -r "done in smoke"
run ready; has "Gamma blocked"; lacks "Alpha renamed"
run reopen "$A"; run list; has "Alpha renamed"
run close "$A" "$B" -r "multi close"

# --- dependencies
run dep add "$D" "$C"; run dep list "$D"; has "$C"
run dep remove "$D" "$C"; run dep list "$D"; lacks "$C"

# --- comments, memories, config
run comment "$C" "first comment"; run comments "$C"; has "first comment"
run remember "smoke memory about widgets" --key smoke-mem; run memories; has smoke-mem
run recall smoke-mem; has widgets
run forget smoke-mem; run memories; lacks smoke-mem
run remember "memory carried by export" --key smoke-export-mem
run export --all -o mem.jsonl; grep -q '"_type":"memory","key":"smoke-export-mem"' mem.jsonl || { echo "FAIL: export --all lacks the memory line"; exit 1; }
run forget smoke-export-mem
run config set custom.smoke smoke-value; run config get custom.smoke; has smoke-value
run config list; has custom.smoke
run config unset custom.smoke; run config get custom.smoke; lacks smoke-value

# --- history, batch, export, import
run history "$C"
run dep add "$C" "$D"; run dep list "$C"; has "$D"
printf 'create task 2 "Batch one"\nupdate %s priority=1\nclose %s done\ndep remove %s %s\n' "$C" "$D" "$C" "$D" >ops.txt
run batch -f ops.txt; has "4 operations"
run dep list "$C"; lacks "$D"
run list --all; has "Batch one"; has "Gamma blocked"
printf 'create task 2 "Batch rollback"\nupdate does-not-exist priority=1\n' >bad.txt
n=$((n + 1)); if "$BD" batch -f bad.txt >/dev/null 2>&1; then echo "FAIL #$n: failing batch exited 0"; exit 1; fi
run list --all; lacks "Batch rollback"
# a callback that fails last leaves nothing of the dependency add and the create before it
printf 'dep add %s %s\ncreate task 2 "Batch rollback two"\nupdate does-not-exist priority=1\n' "$C" "$D" >bad2.txt
n=$((n + 1)); if "$BD" batch -f bad2.txt >/dev/null 2>&1; then echo "FAIL #$n: failing batch exited 0"; exit 1; fi
run dep list "$C"; lacks "$D"
run list --all; lacks "Batch rollback two"
run export -o export.jsonl; [ -s export.jsonl ] || { echo "FAIL: empty export"; exit 1; }
printf '{"id":"%s-imp1","title":"Imported one","status":"open","priority":2,"issue_type":"task"}\n' "$TRACKER" >import.jsonl
run import import.jsonl; run show "$TRACKER-imp1"; has "Imported one"

# --- delete, prime, doctor
run create "Doomed" -t chore --json; X=$(idof)
run delete "$X" --force; n=$((n + 1)); if "$BD" show "$X" >/dev/null 2>&1; then echo "FAIL #$n: deleted issue still shows"; exit 1; fi
run prime
# doctor is Dolt-shaped upstream (cmd/bd/doctor/database.go opens the local Dolt
# database itself, and the prime probe execs a `bd` from PATH), so two checks report
# errors that only mean "this is not a Dolt workspace" or "no bd on PATH". Anything
# else is real.
n=$((n + 1)); OUT=$("$BD" doctor 2>&1)
OTHER=$(printf '%s
' "$OUT" | grep '✖' | grep -v -e 'Database: No dolt database found' -e 'bd prime Command' | grep -v 'passed.*errors' || true)
[ -z "$OTHER" ] || { echo "FAIL #$n: doctor reports real errors"; echo "$OTHER"; exit 1; }
echo "ok   #$n: bd doctor (only the two Dolt-shaped checks complain)"
# doctor starts a local Dolt server for its Dolt checks; do not leave it behind.
for _ in 1 2 3 4 5; do [ -f .beads/dolt-server.pid ] && break; sleep 1; done
if [ -f .beads/dolt-server.pid ]; then
  pid=$(cat .beads/dolt-server.pid)
  taskkill //F //PID "$pid" >/dev/null 2>&1 || kill "$pid" >/dev/null 2>&1 || true
  sleep 1
fi

echo "PASS: $n steps on tracker $TRACKER"
