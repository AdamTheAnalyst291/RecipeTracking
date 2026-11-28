#!/usr/bin/env bash
# Sends a phone alert through ntfy.sh when the nightly warehouse build fails (card W1).
# The topic is the `ntfy-topic` secret in the environment's main Key Vault, the same one the
# bank sync alerts use (card $2): anyone who knows the name can read the topic, so it stays
# out of git and out of the logs. Needs `az` signed in as an identity that can read that
# one secret.
#
#   KEY_VAULT_NAME=kv-kitchen-dev-abc123 bash warehouse/scripts/alert.sh "<title>" "<message>"
#
# With DRY_RUN=true it prints what it would send and touches neither Key Vault nor ntfy.
# Tests: warehouse/scripts/tests/alert.test.sh.
set -euo pipefail

title="${1:?Give a title}"
message="${2:?Give a message}"
: "${KEY_VAULT_NAME:?Set KEY_VAULT_NAME to the main Key Vault of the environment}"

if [ "${DRY_RUN:-false}" = "true" ]; then
  echo "Would send to the ntfy-topic secret's topic in $KEY_VAULT_NAME: $title: $message"
  exit 0
fi

topic="$(az keyvault secret show --vault-name "$KEY_VAULT_NAME" --name ntfy-topic --query value -o tsv | tr -d '\r\n ')"
if [ "${GITHUB_ACTIONS:-}" = "true" ] && [ -n "$topic" ]; then echo "::add-mask::$topic"; fi
if ! [[ "$topic" =~ ^[A-Za-z0-9_-]{1,64}$ ]]; then
  echo "The ntfy-topic secret in $KEY_VAULT_NAME is not a topic name (letters, digits, - and _)." >&2
  exit 1
fi

curl -fsS --retry 3 -o /dev/null \
  -H "Title: $title" -H "Priority: high" -H "Tags: warehouse" \
  --data-binary "$message" "https://ntfy.sh/$topic"
echo "Alert sent."
