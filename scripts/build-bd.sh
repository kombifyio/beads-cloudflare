#!/usr/bin/env bash
# Build bd with the Cloudflare backend: upstream bd at a release tag plus one blank
# import of this repository's Go module (bd/). Nothing in upstream is patched.
#
#   scripts/build-bd.sh <upstream-tag> <output-path> [module-dir]
#
# Environment:
#   UPSTREAM_REPO   git URL or path of upstream beads (default: github gastownhall/beads)
#   ADAPTER_VERSION when set (e.g. v0.1.0), require that published version of the bd/
#                   module instead of replacing it with module-dir. The default replaces
#                   the module with the bd/ directory next to this script, so a build
#                   needs no published version at all.
#   ADAPTER_SHA     optional build identifier (for example a short git sha) recorded as
#                   main.Build; it does not change the version stamp.
#
# The binary is the CGO-free flavor upstream ships for Windows and as its pure-Go
# build (CGO_ENABLED=0, -tags gms_pure_go). It is stamped
# <upstream version>+cloudflare.<VERSION>, where VERSION is the single version file
# at the root of this repository, and the backend carries the same VERSION so it can
# compare it with the store it connects to (docs/compatibility.md).
# Works in Git Bash, Linux and macOS.
set -euo pipefail

TAG=${1:?usage: build-bd.sh <upstream-tag> <output-path> [module-dir]}
OUT=${2:?usage: build-bd.sh <upstream-tag> <output-path> [module-dir]}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ADAPTER=${3:-$HERE/bd}
UPSTREAM_REPO=${UPSTREAM_REPO:-https://github.com/gastownhall/beads.git}
MODULE=github.com/kombifyio/beads-cloudflare/bd

native() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

case "$OUT" in /*|[A-Za-z]:*) ;; *) OUT="$(pwd)/$OUT" ;; esac
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

VERSION_FILE="$HERE/VERSION"
[ -f "$VERSION_FILE" ] || { echo "build-bd: $VERSION_FILE is missing" >&2; exit 1; }
ADAPTER_V=$(tr -d '[:space:]' <"$VERSION_FILE")
case "$ADAPTER_V" in [0-9]*.[0-9]*.[0-9]*) ;; *) echo "build-bd: VERSION '$ADAPTER_V' is not a semantic version" >&2; exit 1 ;; esac
VERSION="${TAG#v}+cloudflare.${ADAPTER_V}"
BUILD="cloudflare.${ADAPTER_SHA:-$ADAPTER_V}"

git clone --quiet --depth 1 --branch "$TAG" "$UPSTREAM_REPO" "$WORK/src"
cd "$WORK/src"

# The one import. Registration is the only wiring; a workspace selects the
# backend by name in .beads/metadata.json.
cat >cmd/bd/zz_backend_cloudflare.go <<'EOF'
package main

// bd with the Cloudflare store backend: upstream bd plus this import.
import _ "github.com/kombifyio/beads-cloudflare/bd/backend"
EOF

if [ -n "${ADAPTER_VERSION:-}" ]; then
  go mod edit -require="$MODULE@$ADAPTER_VERSION"
else
  go mod edit -require="$MODULE@v0.0.0" -replace="$MODULE=$(native "$ADAPTER")"
fi

# Raise the go directive only when the adapter needs a newer language version
# than upstream pins; with matching pins the upstream go.mod stays as it is.
upstream_go=$(go mod edit -json | sed -n 's/.*"Go": *"\([^"]*\)".*/\1/p' | head -1)
adapter_go=$(sed -n 's/^go \([0-9][0-9.]*\)$/\1/p' "$ADAPTER/go.mod" | head -1)
if [ -n "$adapter_go" ] && [ "$(printf '%s\n%s\n' "$upstream_go" "$adapter_go" | sort -V | tail -1)" != "$upstream_go" ]; then
  echo "build-bd: adapter needs go $adapter_go, upstream pins $upstream_go; raising the directive" >&2
  go mod edit -go="$adapter_go"
fi

export GOWORK=off CGO_ENABLED=0
go mod tidy >/dev/null
go build -tags gms_pure_go \
  -ldflags "-X main.Version=${VERSION} -X main.Build=${BUILD} -X ${MODULE}/cloudflare.Version=${ADAPTER_V}" \
  -o "$OUT" ./cmd/bd
echo "built $OUT ($VERSION)"
