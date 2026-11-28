# Claude connector (MCP endpoint)

The API's MCP server (card P1, ADR-26) lives at `https://<api-host>/api/mcp`. It speaks Streamable HTTP, statelessly: both the 2026-07-28 protocol and the 2025 handshake that Claude's connectors use today. Money tools come with card $5.

## Tools

All act within the signed-in member's household, through the same functions and stores as the web app.

| Tool | What it does |
|---|---|
| `get_recipes` | The saved recipes, or one in full. |
| `get_meal_plan` | Seven days of planned meals. |
| `check_pantry` | Products with stock and price. |
| `get_shopping_list` | The latest shopping list. |
| `plan_meals` | Adds up to 28 meals to the plan. If any recipe id is wrong, none are added. |
| `build_shopping_list` | A new list from the plan for the given days, less what staples hold. |
| `mark_cooked` | "I made this": takes the ingredients out of pantry stock and records it. Can't be undone. |
| `save_recipe` | A new recipe from a web page (the importer, which only reaches public websites) or from fields Claude read from text. Saved straight away, without the web app's check-the-draft step. |

Recipe and page text is untrusted data. The tool descriptions tell Claude to write only when the person asks, but that is guidance, not a control: keep the connector asking for approval before write tools (**Settings → Connectors**), above all `save_recipe` with a URL, which fetches whatever address Claude gives.

## How sign-in works

- **No token, or a bad one:** the endpoint answers 401 with `WWW-Authenticate: Bearer resource_metadata="https://<api-host>/api/.well-known/oauth-protected-resource/mcp", scope="https://<api-host>/api/mcp/access_as_user offline_access"`.
- **The metadata** (RFC 9728, public) names the endpoint as the resource and `https://login.microsoftonline.com/<tenant>/v2.0` as its only authorization server. Claude then reads Entra's OpenID configuration from there.
- **Claude signs Adam in through Entra** with its own pre-registered client, `kitchen-claude-<env>` (ADR-32, proposed). Entra has no dynamic client registration, and its Client ID Metadata Document preview can't issue tokens for a custom API.
- **Claude sends RFC 8707 `resource=https://<api-host>/api/mcp`.** Entra accepts it only if that URL is one of kitchen-<env>'s Application ID URIs, so step 1 below adds it.
- **The access token** is an ordinary v2 token for kitchen-<env>: `aud` is its client ID and `scp` contains `access_as_user`. The API checks it exactly as it checks the web app's (`apps/api/src/auth.ts`): tenant, audience, RS256 signature, scope, and household membership. Only Adam gets in.
- **Requests with an `Origin` header** (a web page) are refused with 403. Claude calls from Anthropic's servers and sends none.
- **Rate limit:** 120 calls a minute per member and per running instance; more get 429 with `Retry-After: 60`.
- **The advertised address** comes from Azure's `WEBSITE_HOSTNAME` (the app's own host name), never from the request's Host header.
- **Tokens aren't tied to the MCP endpoint.** A token for kitchen-<env> works on the REST routes and on `/api/mcp` alike, whichever client got it, since both hold callers to the same rules. Only Adam's account gets in either way.

## Set up (one time per environment)

Run in bash (Git Bash works), signed in to the Azure CLI as the subscription owner, after the PR that adds the endpoint has deployed. For Prod, set `env=prod` and leave out the MCP Inspector redirect.

```bash
env=dev
api=$(az functionapp list -g rg-kitchen-$env --query "[0].defaultHostName" -o tsv)
mcp="https://$api/api/mcp"
kitchen=$(az ad app list --display-name kitchen-$env --query "[0].appId" -o tsv)
echo "MCP endpoint: $mcp  kitchen app: $kitchen"
```

1. **Let Entra accept the MCP address as kitchen-<env>'s resource.** This changes kitchen-<env>, the web app's registration. It keeps `api://<client id>`, which the web app asks for, and adds the MCP URL; tokens' `aud` stays the client ID, so the web app's sign-in is unaffected. Nothing else on kitchen-<env> changes.

   ```bash
   az ad app update --id "$kitchen" --identifier-uris "api://$kitchen" "$mcp"
   az ad app show --id "$kitchen" --query identifierUris
   ```

   `*.azurewebsites.net` isn't a verified domain. Per Claude's connector troubleshooting guide, citing Microsoft's identifier-URI rules, Entra accepts it for a single-tenant app that issues v2 tokens (`requestedAccessTokenVersion: 2`, set when kitchen-<env> was made). If the update is refused with a verified-domain error, stop and tell the parent session: that changes the design.

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

4. **Make the client secret.** It expires in 6 months. The command prints it once: copy it straight into Claude's connector settings (step 5), then clear the terminal. It goes nowhere else: not Key Vault, not git, not chat.

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

In Inspector, set the transport to **Streamable HTTP**, the connection type to **Via Proxy**, and the URL to `$mcp`. The endpoint refuses browser-direct calls, because they carry an `Origin` header, and it has no CORS preflight.

- **Without signing in:** **Connect** must fail with 401.
- **Signing in:** under **Authentication**, set the client ID to `$claude` and leave the secret empty: Inspector redeems the code from the browser through the SPA redirect. Set the scope to the value of `echo "$mcp/access_as_user offline_access"`. Sign in, then **List Tools**: the eight tools appear, and each read tool answers with your Dev data. The write tools change that data.

Not yet tried against Dev: whether Inspector's browser-side OAuth can read the metadata document. The Functions app's platform CORS, which allows only the web app, may drop the document's `Access-Control-Allow-Origin: *`. If it does, check from Claude itself (step 5) instead.

## Renewing the secret

Before the 6 months are up, rerun step 4 and paste the new secret into the connector's settings.
