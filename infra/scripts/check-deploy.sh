#!/usr/bin/env bash
# Smoke checks after a deploy, used by the Deploy Dev and Deploy Prod workflows:
# the API's health check answers, /api/me refuses a request without a token, the web
# app loads with a config.json pointing at the API, and the API allows the web app's
# origin. Writes a short summary when GITHUB_STEP_SUMMARY is set.
#
#   ENV_LABEL=Dev WEB_URL=https://... API_URL=https://... AUTH_CLIENT_ID=<id or empty> \
#     infra/scripts/check-deploy.sh
set -uo pipefail

: "${ENV_LABEL:?Set ENV_LABEL, such as Dev or Prod}"
: "${WEB_URL:?Set WEB_URL}"
: "${API_URL:?Set API_URL}"
AUTH_CLIENT_ID="${AUTH_CLIENT_ID:-}"
check_attempts="${CHECK_ATTEMPTS:-24}"
check_delay="${CHECK_DELAY:-10}"

wait_for() { # wait_for <url> <text>: retry while the new version starts up
  for attempt in $(seq 1 "$check_attempts"); do
    body=$(curl -fsS --max-time 20 "$1" || true)
    if grep -qF -- "$2" <<< "$body"; then echo "OK: $1"; return 0; fi
    echo "Waiting for $1 (attempt $attempt)"; sleep "$check_delay"
  done
  echo "::error::$1 did not return the expected content"; return 1
}

wait_for "$API_URL/api/health" '"status":"ok"' || exit 1

# Sign-in is enforced: no token, no entry.
me=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "$API_URL/api/me")
echo "GET /api/me without a token: HTTP $me"
case "$me" in
  401) ;;
  500)
    if [ -n "$AUTH_CLIENT_ID" ]; then echo "::error::The API's sign-in settings are broken (HTTP 500 on /api/me). Is the household-members secret in Key Vault?"; exit 1; fi
    echo "::warning::Sign-in isn't set up on $ENV_LABEL yet: set KITCHEN_AUTH_CLIENT_ID and the household-members secret (infra/README.md, \"Sign-in\")" ;;
  *) echo "::error::/api/me without a token should be 401, got $me"; exit 1 ;;
esac

wait_for "$WEB_URL/config.json" "$API_URL" || exit 1
wait_for "$WEB_URL/" 'id="root"' || exit 1

cors=$(curl -sSI -H "Origin: $WEB_URL" "$API_URL/api/health" | tr -d '\r' | grep -i '^access-control-allow-origin' || true)
echo "CORS header: ${cors:-none}"
[ -n "$cors" ] || { echo "::error::The API does not allow the web app's origin"; exit 1; }

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### $ENV_LABEL is up"
    echo "- Web app: $WEB_URL"
    echo "- API: $API_URL/api/health"
  } >> "$GITHUB_STEP_SUMMARY"
fi
