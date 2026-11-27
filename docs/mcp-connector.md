# Claude connector (MCP endpoint)

The API's MCP server (card P1, ADR-26) lives at `https://<api-host>/api/mcp`. It speaks Streamable HTTP, statelessly: both the 2026-07-28 protocol and the 2025 handshake that Claude's connectors use today. Its read tools are `get_recipes`, `get_meal_plan`, `check_pantry` and `get_shopping_list`. Write tools come with card P2, money tools with card $5.

## How sign-in works

- **No token, or a bad one:** the endpoint answers 401 with `WWW-Authenticate: Bearer resource_metadata="https://<api-host>/api/.well-known/oauth-protected-resource/mcp", scope="https://<api-host>/api/mcp/access_as_user offline_access"`.
- **The metadata** (RFC 9728, public) names the endpoint as the resource and `https://login.microsoftonline.com/<tenant>/v2.0` as its only authorization server. Claude then reads Entra's OpenID configuration from there.
- **Claude signs Adam in through Entra** with its own pre-registered client, `kitchen-claude-<env>` (ADR-32, proposed). Entra has no dynamic client registration, and its Client ID Metadata Document preview can't issue tokens for a custom API.
- **Claude sends RFC 8707 `resource=https://<api-host>/api/mcp`.** Entra accepts it only if that URL is one of kitchen-<env>'s Application ID URIs, so step 1 below adds it.
- **The access token** is an ordinary v2 token for kitchen-<env>: `aud` is its client ID and `scp` contains `access_as_user`. The API checks it exactly as it checks the web app's (`apps/api/src/auth.ts`): tenant, audience, RS256 signature, scope, and household membership. Only Adam gets in.
- **Requests with an `Origin` header** (a web page) are refused with 403. Claude calls from Anthropic's servers and sends none.

## Set up (one time per environment)

Run in bash (Git Bash works), signed in to the Azure CLI as the subscription owner, after the PR that adds the endpoint has deployed. For Prod, set `env=prod` and leave out the MCP Inspector redirect.

```bash
env=dev
api=$(az functionapp list -g rg-kitchen-$env --query "[0].defaultHostName" -o tsv)
mcp="https://$api/api/mcp"
kitchen=$(az ad app list --display-name kitchen-$env --query "[0].appId" -o tsv)
echo "MCP endpoint: $mcp  kitchen app: $kitchen"
```

1. **Let Entra accept the MCP address as kitchen-<env>'s resource.** Keep `api://<client id>`, which the web app uses, and add the MCP URL. Nothing else on kitchen-<env> changes.

   ```bash
   az ad app update --id "$kitchen" --identifier-uris "api://$kitchen" "$mcp"
   az ad app show --id "$kitchen" --query identifierUris
   ```

   `*.azurewebsites.net` isn't a verified domain. Entra allows it here only because the app already issues v2 tokens (`requestedAccessTokenVersion: 2`, set when kitchen-<env> was made).

2. **Create Claude's client, `kitchen-claude-<env>`:** this tenant only, Claude's callback as a web redirect, and permission to call kitchen-<env> as you. On Dev it also gets MCP Inspector's callback as a single-page-app redirect, for testing. Copy the block as it is (the heredoc's closing `EOF` must start its line):

```bash
scope=$(az ad app show --id "$kitchen" --query "api.oauth2PermissionScopes[?value=='access_as_user'].id | [0]" -o tsv)
graph=00000003-0000-0000-c000-000000000000
offline=7427e0e9-2fba-42fe-b0c0-848c9e6a8182   # Microsoft Graph's offline_access, for refresh tokens
claude=$(az ad app create --display-name kitchen-claude-$env --sign-in-audience AzureADMyOrg --query appId -o tsv)
obj=$(az ad app show --id "$claude" --query id -o tsv)
spa='[]'; [ "$env" = dev ] && spa='["http://localhost:6274/oauth/callback"]'
cat > claude-app.json <<EOF
{
  "web": { "redirectUris": ["https://claude.ai/api/mcp/auth_callback"] },
  "spa": { "redirectUris": $spa },
  "requiredResourceAccess": [
    { "resourceAppId": "$kitchen", "resourceAccess": [{ "id": "$scope", "type": "Scope" }] },
    { "resourceAppId": "$graph", "resourceAccess": [{ "id": "$offline", "type": "Scope" }] }
  ]
}
EOF
az rest --method PATCH --uri "https://graph.microsoft.com/v1.0/applications/$obj" \
  --headers Content-Type=application/json --body @claude-app.json
rm claude-app.json
az ad sp create --id "$claude"
```

3. **Consent once, for the tenant,** so signing in shows no consent screen:

   ```bash
   az ad app permission grant --id "$claude" --api "$kitchen" --scope access_as_user
   az ad app permission grant --id "$claude" --api "$graph" --scope offline_access
   ```

4. **Make the client secret.** It expires in 6 months. It goes only into Claude's connector settings: not Key Vault, not git, not chat.

   ```bash
   az ad app credential reset --id "$claude" --display-name claude-connector \
     --end-date "$(date -d '+6 months' +%Y-%m-%d)" --query password -o tsv
   echo "Client ID: $claude"
   ```

5. **Add the connector in Claude** (claude.ai, **Settings → Connectors → Add custom connector**). Use the name `Kitchen (Dev)` and the URL from `echo $mcp`. Under **Authentication → OAuth client**, choose **Use your own OAuth client** and paste the client ID and secret. Then **Connect** and sign in as yourself. The connector then works on the phone too (card P3).

## Check it with MCP Inspector (Dev)

```bash
npx @modelcontextprotocol/inspector@2.15.0
```

In Inspector, set the transport to **Streamable HTTP** and the URL to `$mcp`.

- **Without signing in:** **Connect** must fail with 401.
- **Signing in:** under **Authentication**, set the client ID to `$claude` (leave the secret empty: Inspector redeems the code from the browser through the SPA redirect) and the scope to `https://<api-host>/api/mcp/access_as_user offline_access`. Sign in, then **List Tools**: the four tools appear, and each answers with your Dev data.

If Inspector's browser can't read the metadata document, the Functions app's platform CORS (which only allows the web app) may be dropping its `Access-Control-Allow-Origin: *`. Use Inspector's **Via Proxy** connection, or check from Claude instead.

## Renewing the secret

Before the 6 months are up, rerun step 4 and paste the new secret into the connector's settings.
