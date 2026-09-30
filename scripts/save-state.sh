#!/usr/bin/env bash
# Encrypt memory_store/ and force-push it as a single-commit orphan branch "state".
# (single commit = repository never grows, no history of session keys)
set -euo pipefail
cd "$(dirname "$0")/.."
: "${STATE_PASSPHRASE:?STATE_PASSPHRASE is required}"
: "${GITHUB_TOKEN:?GITHUB_TOKEN is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"

OUT="$(mktemp /tmp/mz-state-XXXXXX.enc)"
node scripts/state.js pack "$OUT"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP" "$OUT"' EXIT
cd "$TMP"
git init -q -b state
cp "$OUT" memory_store.enc
git add memory_store.enc
git -c user.name="mizanora-bot" -c user.email="mizanora-bot@users.noreply.github.com" commit -q -m "state $(date -u +%FT%TZ)"
git push -q -f "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" state
echo "state saved to branch 'state' at $(date -u +%FT%TZ)"
