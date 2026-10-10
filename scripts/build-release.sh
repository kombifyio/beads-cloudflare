#!/usr/bin/env bash
# Shared public recipe; publication still belongs to the governed private publisher.
# Usage: bash scripts/build-release.sh <new-dist-directory> <new-build-directory>
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DIST=${1:?usage: build-release.sh <new-dist-directory> <new-build-directory>}
BUILD=${2:?usage: build-release.sh <new-dist-directory> <new-build-directory>}
case "$DIST" in /*|[A-Za-z]:*) ;; *) DIST="$(pwd)/$DIST" ;; esac
case "$BUILD" in /*|[A-Za-z]:*) ;; *) BUILD="$(pwd)/$BUILD" ;; esac
[ ! -e "$DIST" ] && [ ! -e "$BUILD" ] || { echo "release output directories must be absent" >&2; exit 1; }
TAG=$(sed -n 's/^- Tag: //p' "$ROOT/spec/upstream/SOURCE.md" | tr -d '\r')
PIN=$(sed -n 's/^- Commit: //p' "$ROOT/spec/upstream/SOURCE.md" | tr -d '\r')
TOOLCHAIN=$(node -e 'const fs=require("node:fs");const p=JSON.parse(fs.readFileSync(process.argv[1]));if(!/^go[0-9]+\.[0-9]+\.[0-9]+$/.test(p.go_toolchain))process.exit(1);console.log(p.go_toolchain)' "$ROOT/spec/upstream/build-overlay.json")
[[ "$PIN" =~ ^[a-f0-9]{40}$ ]] || { echo "upstream source pin is invalid" >&2; exit 1; }
export GOTOOLCHAIN="$TOOLCHAIN" TZ=UTC
SCRATCH=$(mktemp -d)
trap 'rm -rf "$SCRATCH"' EXIT
git clone --quiet --depth 1 --branch "$TAG" "${UPSTREAM_REPO:-https://github.com/gastownhall/beads.git}" "$SCRATCH/upstream"
[ "$(git -C "$SCRATCH/upstream" rev-parse HEAD)" = "$PIN" ] || { echo "upstream source pin mismatch" >&2; exit 1; }
export UPSTREAM_REPO="$SCRATCH/upstream"
mkdir -p "$DIST" "$BUILD"
for target in linux/amd64 linux/arm64 darwin/arm64 darwin/amd64 windows/amd64; do
  os="${target%/*}"; arch="${target#*/}"
  name=bd; [ "$os" != windows ] || name=bd.exe
  out="$BUILD/${os}-${arch}"
  mkdir -p "$out"
  GOOS="$os" GOARCH="$arch" bash "$ROOT/scripts/build-bd.sh" "$TAG" "$out/$name"
  node "$ROOT/scripts/binary-notices.mjs" "$out/$name" "$UPSTREAM_REPO"
  files=("$name" LICENSE THIRD-PARTY-NOTICES.md THIRD-PARTY-LICENSES.txt BUILD-PROVENANCE.json)
  # Archive headers are stable across build times; the exact Go toolchain is pinned above.
  if [ "$os" = windows ]; then
    (cd "$out" && touch -t 198001010000 "${files[@]}" && zip -X -q "$DIST/bd_${os}_${arch}.zip" "${files[@]}")
  else
    tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -C "$out" -cf - "${files[@]}" | gzip -n > "$DIST/bd_${os}_${arch}.tar.gz"
  fi
done
(cd "$DIST" && sha256sum bd_* > SHA256SUMS)
node "$ROOT/scripts/release-artifacts.mjs" "$DIST"
