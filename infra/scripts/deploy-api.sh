#!/usr/bin/env bash
# Deploys the API zip to a Flex Consumption Functions app, then waits for the
# deployment to finish. Used by the Deploy Dev and Deploy Prod workflows, signed in
# to the Azure CLI as the environment's deploy identity.
#
#   FUNCTION_APP=<name> API_ZIP=build/api.zip infra/scripts/deploy-api.sh
#
# `az functionapp deploy` and `config-zip` don't work for Flex Consumption (Setlist
# found the first gets HTTP 415 and the second fails its host-key health check), so
# this posts the zip to the publish endpoint directly (it must be application/zip).
#
# A brand-new app's publish endpoint can refuse the first upload (Dev's first deploy
# got HTTP 400 and passed on a rerun), so the upload is retried a few times.
set -euo pipefail

: "${FUNCTION_APP:?Set FUNCTION_APP to the Functions app name}"
: "${API_ZIP:?Set API_ZIP to the API zip}"
publish_attempts="${PUBLISH_ATTEMPTS:-5}"
publish_retry_delay="${PUBLISH_RETRY_DELAY:-30}"
status_attempts="${STATUS_ATTEMPTS:-36}"
status_delay="${STATUS_DELAY:-10}"

scm="https://$FUNCTION_APP.scm.azurewebsites.net"
token=$(az account get-access-token --query accessToken -o tsv)
echo "::add-mask::$token"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

location=""
for attempt in $(seq 1 "$publish_attempts"); do
  code=$(curl -sS -D "$work/headers" -o "$work/body" -w '%{http_code}' -X POST \
    -H "Authorization: Bearer $token" -H "Content-Type: application/zip" \
    --data-binary "@$API_ZIP" "$scm/api/publish?type=zip") || code="000"
  if [[ "$code" == 2* ]]; then
    location=$(tr -d '\r' < "$work/headers" | awk -F': ' 'tolower($1)=="location" {print $2}')
    [ -n "$location" ] || { echo "::error::The publish endpoint returned no deployment to follow"; exit 1; }
    echo "Upload accepted (HTTP $code, attempt $attempt)"
    break
  fi
  echo "Upload refused: HTTP $code (attempt $attempt of $publish_attempts)"
  head -c 500 "$work/body" 2>/dev/null && echo
  if [ "$attempt" -lt "$publish_attempts" ]; then sleep "$publish_retry_delay"; fi
done
[ -n "$location" ] || { echo "::error::The publish endpoint refused the API zip $publish_attempts times"; exit 1; }

for attempt in $(seq 1 "$status_attempts"); do
  status=$(curl -sS -f -H "Authorization: Bearer $token" "$location" \
    | sed -n 's/.*"status"[[:space:]]*:[[:space:]]*\(-\{0,1\}[0-9]*\).*/\1/p') || status=""
  echo "Deployment status: ${status:-unknown} (attempt $attempt)"
  case "$status" in
    4) exit 0 ;; # succeeded
    3) echo "::error::The API deployment failed"; exit 1 ;;
  esac
  sleep "$status_delay"
done
echo "::error::The API deployment did not finish in time"
exit 1
