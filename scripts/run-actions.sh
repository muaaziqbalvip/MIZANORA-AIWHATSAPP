#!/usr/bin/env bash
# Runs one Mizanora "shift" on a GitHub Actions runner:
#   restore state → start bot (+ periodic checkpoints) → graceful stop → save state.
cd "$(dirname "$0")/.."
START=$(date +%s)
OUTFILE="${GITHUB_OUTPUT:-/dev/null}"

# 1) restore previous state (never continue with an empty state if a saved one exists)
if git fetch -q --depth=1 origin state:refs/remotes/origin/state 2>/dev/null; then
  git show origin/state:memory_store.enc > /tmp/state.enc
  if ! node scripts/state.js unpack /tmp/state.enc; then
    echo "::error::A saved state exists but could not be decrypted (wrong STATE_PASSPHRASE?). Aborting to protect it."
    echo "code=2" >> "$OUTFILE"; exit 2
  fi
elif [ -n "${WHATSAPP_AGENT_API_KEY:-}" ]; then
  echo "No saved state yet — first run (WhatsApp Agent Platform needs no pairing)."
else
  echo "::notice::No WHATSAPP_AGENT_API_KEY secret and not paired via Baileys. Add the agent API key secret (or run '1 - Pair WhatsApp'). Nothing to do now."
  echo "code=skip" >> "$OUTFILE"; exit 0
fi

# 2) periodic checkpoint in the background (crash / cancel protection)
( while true; do sleep "${SAVE_INTERVAL_SEC:-1800}"; bash scripts/save-state.sh || echo "periodic save failed"; done ) &
SAVER=$!

# 3) the bot itself
node src/index.js &
NODE=$!
trap 'kill -TERM "$NODE" 2>/dev/null' TERM INT
wait "$NODE"; CODE=$?
if kill -0 "$NODE" 2>/dev/null; then wait "$NODE"; CODE=$?; fi   # trap interrupted the first wait

kill "$SAVER" 2>/dev/null

# 4) final save
bash scripts/save-state.sh || echo "::warning::final state save failed"

echo "code=$CODE" >> "$OUTFILE"
ELAPSED=$(( $(date +%s) - START ))
if [ "$CODE" -eq 2 ] || [ "$CODE" -eq 3 ]; then exit "$CODE"; fi   # needs human: re-pair / duplicate session
if [ "$CODE" -ne 0 ] && [ "$ELAPSED" -lt 90 ]; then echo "Crashed fast — cooling down 120s before next shift"; sleep 120; fi
exit 0
