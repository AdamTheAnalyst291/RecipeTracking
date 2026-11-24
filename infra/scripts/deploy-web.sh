#!/usr/bin/env bash
# Deploys the web app to a Static Web App, with a config.json pointing at the
# environment's API. Used by the Deploy Dev and Deploy Prod workflows, signed in to
# the Azure CLI as the environment's deploy identity. The deployment token is fetched
# here and masked, so it is never stored in GitHub.
#
#   RESOURCE_GROUP=rg-kitchen-dev SWA_NAME=<name> API_URL=https://... \
#     AUTH_CLIENT_ID=<id or empty> TENANT_ID=<id> WEB_DIR=build/web infra/scripts/deploy-web.sh
set -euo pipefail

: "${RESOURCE_GROUP:?Set RESOURCE_GROUP}"
: "${SWA_NAME:?Set SWA_NAME to the Static Web App name}"
: "${API_URL:?Set API_URL}"
: "${WEB_DIR:?Set WEB_DIR to the built web app}"
AUTH_CLIENT_ID="${AUTH_CLIENT_ID:-}"
TENANT_ID="${TENANT_ID:-}"

# An empty clientId leaves sign-in off until the app registration exists.
jq -n --arg apiUrl "$API_URL" --arg clientId "$AUTH_CLIENT_ID" --arg tenantId "$TENANT_ID" \
  '{apiUrl: $apiUrl, auth: {clientId: $clientId, tenantId: $tenantId}}' > "$WEB_DIR/config.json"
token=$(az staticwebapp secrets list -g "$RESOURCE_GROUP" -n "$SWA_NAME" --query properties.apiKey -o tsv)
echo "::add-mask::$token"
SWA_CLI_DEPLOYMENT_TOKEN="$token" npx --yes @azure/static-web-apps-cli@2.1.0 deploy "$WEB_DIR" --env production
