#!/usr/bin/env bash
# Completes a GitHub release whose assets are only partly there (an earlier run created the release and
# then failed while uploading), without moving the tag.
#
#   scripts/complete-release.sh <owner/repo> <tag> <dist dir>
#
# <dist dir> holds the freshly built archives (bd_<os>_<arch>.{tar.gz,zip}) and SHA256SUMS. Archives the release
# already has are kept exactly as they are; missing ones are uploaded from <dist dir>. SHA256SUMS is then made to
# describe the archives the release really holds: it is uploaded when it is missing or when it disagrees with
# them. Uses the gh CLI with GH_TOKEN in the environment. Prints "complete" when nothing was missing.
set -euo pipefail

REPO=${1:?usage: complete-release.sh <owner/repo> <tag> <dist dir>}
TAG=${2:?usage: complete-release.sh <owner/repo> <tag> <dist dir>}
DIST=${3:?usage: complete-release.sh <owner/repo> <tag> <dist dir>}

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
remote=$(gh release view "$TAG" -R "$REPO" --json assets --jq '.assets[].name')
has() { printf '%s\n' "$remote" | grep -Fxq "$1"; }

# The archives as the release holds them after this run: existing ones as published, missing ones from dist.
upload=()
for file in "$DIST"/bd_*; do
  name=$(basename "$file")
  if has "$name"; then
    gh release download "$TAG" -R "$REPO" -p "$name" -D "$stage"
  else
    cp "$file" "$stage/$name"
    upload+=("$stage/$name")
  fi
done
(cd "$stage" && sha256sum bd_* > SHA256SUMS.expected)

sums_ok=false
if has SHA256SUMS; then
  gh release download "$TAG" -R "$REPO" -p SHA256SUMS -O "$stage/SHA256SUMS.remote" --clobber
  cmp -s "$stage/SHA256SUMS.remote" "$stage/SHA256SUMS.expected" && sums_ok=true
fi

if [ ${#upload[@]} -eq 0 ] && $sums_ok; then
  echo "complete: $TAG in $REPO already holds every asset"
  exit 0
fi
if [ ${#upload[@]} -gt 0 ]; then
  echo "uploading missing archives: $(printf '%s ' "${upload[@]##*/}")"
  gh release upload "$TAG" -R "$REPO" "${upload[@]}"
fi
if ! $sums_ok; then
  echo "uploading SHA256SUMS for the archives the release holds"
  cp "$stage/SHA256SUMS.expected" "$stage/SHA256SUMS"
  gh release upload "$TAG" -R "$REPO" "$stage/SHA256SUMS" --clobber
fi
echo "completed: $TAG in $REPO"
