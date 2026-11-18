#!/usr/bin/env bash
# Completes a GitHub release whose assets are only partly there (an earlier run created the release and
# then failed while uploading), without moving the tag.
#
#   scripts/complete-release.sh <owner/repo> <tag> <dist dir> [--verify-only|--readback]
#
# <dist dir> holds the freshly built archives (bd_<os>_<arch>.{tar.gz,zip}) and SHA256SUMS. Archives the release
# already has must match the expected bytes; differing archives or SHA256SUMS refuse before any upload.
# Only absent files are uploaded. Verification-only checks the same boundary without mutations.
set -euo pipefail

REPO=${1:?usage: complete-release.sh <owner/repo> <tag> <dist dir>}
TAG=${2:?usage: complete-release.sh <owner/repo> <tag> <dist dir>}
DIST=${3:?usage: complete-release.sh <owner/repo> <tag> <dist dir>}
VERIFY=${4:-}
[ -z "$VERIFY" ] || [ "$VERIFY" = --verify-only ] || [ "$VERIFY" = --readback ] || { echo "invalid completion mode" >&2; exit 1; }
# Refuse partial local matrices before even reading the remote release. The
# immutable manifest must describe all five platforms, not whichever files survived.
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
node "$HERE/release-artifacts.mjs" "$DIST"

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
remote=$(gh release view "$TAG" -R "$REPO" --json assets --jq '.assets[].name')
has() { printf '%s\n' "$remote" | grep -Fxq "$1"; }

# The archives as the release holds them after this run: existing ones as published, missing ones from dist.
upload=()
for file in "$DIST"/bd_*; do
  [ -f "$file" ] || { echo "expected archives are missing" >&2; exit 1; }
  name=$(basename "$file")
  expected=$(awk -v name="$name" '$2 == name || $2 == "*" name { print $1 }' "$DIST/SHA256SUMS")
  actual=$(sha256sum --binary "$file")
  [[ "$expected" =~ ^[a-f0-9]{64}$ && "${actual%% *}" = "$expected" ]] || { echo "candidate archive checksum mismatch: $name" >&2; exit 1; }
  if has "$name"; then
    gh release download "$TAG" -R "$REPO" -p "$name" -D "$stage"
    cmp -s "$file" "$stage/$name" || { echo "immutable archive mismatch: $name" >&2; exit 1; }
  else
    cp "$file" "$stage/$name"
    upload+=("$stage/$name")
  fi
done

if has SHA256SUMS; then
  gh release download "$TAG" -R "$REPO" -p SHA256SUMS -O "$stage/SHA256SUMS.remote"
  cmp -s "$stage/SHA256SUMS.remote" "$DIST/SHA256SUMS" || { echo "immutable checksum manifest mismatch" >&2; exit 1; }
else
  cp "$DIST/SHA256SUMS" "$stage/SHA256SUMS"
  upload+=("$stage/SHA256SUMS")
fi

if [ "$VERIFY" = --readback ]; then
  [ ${#upload[@]} -eq 0 ] || { echo "release artifact readback is incomplete" >&2; exit 1; }
  echo "verified complete immutable release: $TAG in $REPO"
  exit 0
fi
if [ "$VERIFY" = --verify-only ]; then
  echo "verified immutable completion candidate: $TAG in $REPO"
  exit 0
fi
if [ ${#upload[@]} -eq 0 ]; then
  echo "complete: $TAG in $REPO already holds every asset"
  exit 0
fi
if [ ${#upload[@]} -gt 0 ]; then
  echo "uploading missing archives: $(printf '%s ' "${upload[@]##*/}")"
  gh release upload "$TAG" -R "$REPO" "${upload[@]}"
fi
echo "completed: $TAG in $REPO"
