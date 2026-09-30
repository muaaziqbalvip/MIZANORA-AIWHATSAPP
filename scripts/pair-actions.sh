#!/usr/bin/env bash
# One-time WhatsApp pairing, entirely on a GitHub runner.
# Prints a pairing code in the job log → you type it on the phone → the session is encrypted and saved to branch `state`.
cd "$(dirname "$0")/.."

if ! [[ "${PAIR_NUMBER:-}" =~ ^[0-9]{8,15}$ ]]; then
  echo "::error::Enter the bot's WhatsApp number with country code, digits only (example: 923001234567)."; exit 1
fi
if [ -z "${STATE_PASSPHRASE:-}" ] || [ "${#STATE_PASSPHRASE}" -lt 12 ]; then
  echo "::error::Secret STATE_PASSPHRASE is missing or shorter than 12 characters."; exit 1
fi

# Do not overwrite an existing paired session / memory unless explicitly forced
if git fetch -q --depth=1 origin state:refs/remotes/origin/state 2>/dev/null && [ "${FORCE:-false}" != "true" ]; then
  echo "::error::A saved state already exists (the bot is already paired). Re-run this workflow with 'force' ticked ONLY if you want to replace it (this erases old memory)."; exit 1
fi

node src/index.js --pair
CODE=$?

if [ "$CODE" -ne 0 ] || ! grep -q '"registered":true' memory_store/wa_auth/creds.json 2>/dev/null; then
  echo "::error::Pairing did not complete (no link within 12 minutes, or the code was wrong). Run the workflow again and enter the NEW code quickly."; exit 1
fi

bash scripts/save-state.sh
echo "✅ Paired and saved. The 24/7 workflow is starting next."
