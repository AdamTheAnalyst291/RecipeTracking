# Infrastructure

Terraform for the kitchen app's Azure environments (ADR-25). It is copied from Setlist's `infra/` and adapted.

| Path | What it is | Who applies it |
|---|---|---|
| `bootstrap/` | One-time setup: Terraform state storage, each environment's resource group and GitHub deploy identity, and the kitchen's budget alert | The subscription owner, by hand |
| `modules/environment/` | One environment: web app, API, Key Vault and app database | Used by the roots below |
| `environments/dev/` | Dev, in `rg-kitchen-dev` | GitHub Actions, on every merge to `main` |
| `environments/prod/` | Prod, in `rg-kitchen-prod`, with its own free database | GitHub Actions, only when Adam approves a **Deploy Prod** run |
| `scripts/` | Deploy and smoke-check scripts both deploy workflows share, and the weekly Prod export (see "Backups"), with tests | Called by the workflows |

Everything lives in the **My-VibeCode** subscription, which also holds Setlist. The kitchen's resources are all in resource groups named `rg-kitchen-*`, in `centralus`. This subscription can't create Azure SQL servers in `eastus2`, `eastus`, `westus`, `westus2` or `northcentralus` ("Provisioning is restricted in this region"); `centralus` has SQL, Flex Consumption and Static Web Apps Free.

## Bootstrap (one time)

Run this from a machine signed in to the Azure CLI as an Owner of My-VibeCode. It needs Terraform 1.17 or later, `gh` signed in with admin rights on this repository, and Node.

1. Check the account first. It must be My-VibeCode and nothing else:

   ```bash
   az login --tenant <tenant-id>
   az account show
   ```

2. Fill in the variables. `terraform.tfvars` is git-ignored because it holds your email address.

   ```bash
   cd infra/bootstrap
   cp terraform.tfvars.example terraform.tfvars
   ```

3. Review the plan, then apply it. It creates:
   - registrations for the resource providers the kitchen app uses (Setlist's bootstrap registers the same ones; registering again is harmless). Application Insights and Log Analytics (`Microsoft.Insights`, `Microsoft.OperationalInsights`) were added later: apply the bootstrap again before the first deploy that creates them, or that deploy fails with `MissingSubscriptionRegistration`
   - `rg-kitchen-tfstate` with a storage account `stkitchentf<suffix>` (Standard LRS, Entra ID access only, versioning and 7-day soft delete) and one container per environment: `tfstate-dev`, `tfstate-prod`
   - per environment (`dev`, `prod`): `rg-kitchen-<env>`, and an app registration `kitchen-github-<env>` whose only credential is a federated credential for `repo:AdamTheAnalyst291@225034465/RecipeTracking@1433625977:environment:<env>`. GitHub puts immutable owner and repository IDs in this repository's OIDC subject, so the trust can't pass to a renamed or recreated repo
   - role assignments for that identity: Contributor on its resource group; Role Based Access Control Administrator on its resource group, limited to granting Storage Blob Data Owner, Key Vault Secrets User and Storage Blob Data Contributor; Storage Blob Data Contributor on its own state container
   - for Prod only: a second app registration, `kitchen-github-prod-backup`, for the weekly database export. Its only credential trusts the `prod-backup` GitHub Environment, and it gets no Azure role here (see "Backups")
   - the `kitchen-monthly` budget, $10 a month, counting only `rg-kitchen-tfstate`, `rg-kitchen-dev` and `rg-kitchen-prod`, emailing at 50% and 100% of actual spend and 100% of forecast

   ```bash
   terraform init
   terraform plan -out=tfplan
   terraform apply tfplan
   ```

   The bootstrap's state stays in `infra/bootstrap/terraform.tfstate` on your machine (git-ignored). Keep it; if it's lost, the resources can be brought back under Terraform with `terraform import`.

4. Create the GitHub Environments and their variables (IDs only; nothing secret is stored in GitHub):

   ```bash
   ./configure-github.sh
   ```

   This sets the repository variables `TF_STATE_RESOURCE_GROUP` and `TF_STATE_STORAGE_ACCOUNT`, and on each environment `AZURE_CLIENT_ID`, `AZURE_PRINCIPAL_ID`, `AZURE_TENANT_ID` and `AZURE_SUBSCRIPTION_ID`. It also creates the `prod-backup` environment (no reviewer, `main` only), sets its `AZURE_*` variables, and sets `AZURE_BACKUP_PRINCIPAL_ID` and `AZURE_BACKUP_CLIENT_ID` on `prod`. It creates an environment only if it's missing, so rerunning it leaves protection rules alone.

5. Make Prod wait for you: in GitHub, **Settings → Environments → prod**, tick **Required reviewers**, add yourself, and under **Deployment branches and tags** allow `main` only, then save. Every Prod deploy then waits for your approval. The repository is public, so GitHub Free offers required reviewers (ADR-30). To deploy by pushing a release tag as well as by hand, also add the tag rule `v*` there (see "Prod" below).

6. Move Setlist's budget off the whole subscription (see below).

## Re-scope Setlist's budget (one time)

Setlist's `setlist-monthly` budget ($5) was created by Setlist's own bootstrap for the whole subscription, so it would also count the kitchen's spend. Limit it to Setlist's resource groups. In the Azure portal:

1. **Cost Management → Budgets**, scope **My-VibeCode**, open `setlist-monthly` and choose **Edit budget**.
2. Under **Filters**, add **Resource group name** and pick `rg-setlist-tfstate` and every `rg-setlist-<env>` group that exists (today `rg-setlist-dev`).
3. Save. The amount and alert emails stay as they are.

Setlist's bootstrap doesn't set a filter, so its next `terraform plan` there will show the filter being removed. Before applying Setlist's bootstrap again, add the same `filter` block to its `azurerm_consumption_budget_subscription.monthly` (this module's `kitchen` budget shows the shape), so the change sticks.

## Adding UAT later

Set `environments = ["dev", "uat", "prod"]` in `terraform.tfvars`, apply again, and rerun `./configure-github.sh`. The budget picks up the new resource group on its own.

## What an environment contains

`modules/environment` builds, in the environment's resource group:

- **Web app:** a Static Web App on the Free plan.
- **API:** a Linux Functions app on Flex Consumption (Node 24) with a system-assigned managed identity. It reaches its own storage account (deployment package and host state) with that identity, not a key, and allows calls from the web app's address (plus `http://localhost:5173` in Dev).
- **Key Vault** with Azure RBAC. The API's identity has Key Vault Secrets User, so it can read secrets and nothing else, and finds the vault through its `KITCHEN_KEY_VAULT_URI` app setting. Terraform never sees secret values.
- **Token vault**, a second Key Vault with Azure RBAC that holds only the Plaid access tokens (card $2). The API's identity has Key Vault Secrets Officer on it, and only on it, so connecting a bank can store its token without the API ever being able to write the main vault. The API finds it through `KITCHEN_TOKEN_VAULT_NAME`.
- **Azure SQL:** a server that accepts Microsoft Entra sign-in only, with the environment's deploy identity (`kitchen-github-<env>`) as its admin so the pipeline can run migrations, and a firewall that lets in Azure services only. Its database uses the free offer and pauses for the rest of the month instead of billing when the free allowance runs out. The API finds it through its `SQL_SERVER` and `SQL_DATABASE` app settings and signs in with its managed identity. That identity is a database user with read and write access to the data (`db_datareader` and `db_datawriter`, nothing more), which the migration step creates after each migration from the identity's client ID (the `function_app_client_id` output).
- **Logs:** a Log Analytics workspace (pay-as-you-go, 30 days' retention) and a workspace-based Application Insights resource, `appi-kitchen-<env>-<suffix>`, which the API's logs and request traces go to. Both cap ingestion at 0.05 GB a day, about 1.5 GB a month per environment, so Dev and Prod together stay inside the 5 GB a month that's free. To read the logs, open the Application Insights resource in the portal and choose **Logs** (for example `traces | where severityLevel >= 3 | order by timestamp desc`) or **Failures**.
- **Database exports** (Prod only, `database_exports`): a storage account (Terraform refuses to destroy it) `stkitchenbak<env><suffix>` with Entra sign-in only, blob versioning, 30-day soft delete and a private `database-exports` container, where the weekly export writes. See "Backups".

Names carry a suffix derived from the subscription, environment and region, so they stay the same from run to run. The Deploy Dev run's summary lists them.

## Secrets you add by hand

Secrets go in the environment's Key Vault, never in git, GitHub or app settings. Terraform and the deploy identity never handle secret values, so you add them yourself, signed in as the subscription owner. First give yourself **Key Vault Secrets Officer** on the vault (portal: the vault, **Access control (IAM)**, **Add role assignment**): an RBAC vault doesn't let even an Owner read or write secrets without a data role.

| Secret name | What it is | Used by |
|---|---|---|
| `plaid-client-id` | Plaid client ID | Bank sync (cards $0 and $2) |
| `plaid-secret` | Plaid secret: the **Sandbox** one in Dev's vault, the **Production** one in Prod's | Bank sync (cards $0 and $2) |
| `household-members` | Entra object IDs of the people allowed in, comma-separated (today just yours) | Sign-in (card F4; see "Sign-in" below) |
| `ntfy-topic` | The ntfy.sh topic the bank sync's failure alerts go to: a long random name of letters, digits, `-` and `_` (anyone who knows it can read the alerts). Subscribe to it in the ntfy phone app. | Bank sync alerts (card $2), and the nightly warehouse build's failure alerts (card W1) |

Plaid access tokens are not on this list: the API writes one itself each time a bank is connected (`plaid-access-token-<item id>`), into a second vault that holds nothing else, `kv-kitchen-<env>-<suffix>-t` (Terraform output `token_vault_name`). The API can write there (Key Vault Secrets Officer) but only read the main vault, so nothing it does can change `household-members`. You don't add anything to the token vault.

To make a phone alert topic: `powershell -NoProfile -Command "'kitchen-' + [guid]::NewGuid().ToString('N')"` gives a name; add it as `ntfy-topic` in both vaults (or a different one per environment), then subscribe to it in the ntfy app.

Add or update one in the portal (the vault, **Objects**, **Secrets**, **Generate/Import**), or with the Azure CLI. Reading the value from a prompt keeps it out of your shell history:

```bash
vault=$(az keyvault list -g rg-kitchen-dev --query "[0].name" -o tsv)
az keyvault secret set --vault-name "$vault" --name plaid-client-id --value "$(read -rsp 'Plaid client ID: ' v; echo "$v")"
az keyvault secret set --vault-name "$vault" --name plaid-secret --value "$(read -rsp 'Plaid secret: ' v; echo "$v")"
```

In PowerShell: `az keyvault secret set --vault-name $vault --name plaid-secret --value (Read-Host 'Plaid secret')`.

## Sign-in (one time per environment)

The web app signs in with Microsoft Entra through MSAL, and every API function except `/api/health` checks the Entra access token the web app sends. A token must come from this tenant, be issued for the environment's app registration with the `access_as_user` scope, and belong to a household member. Anyone else gets 401 (no token or a bad one) or 403 (signed in, but not in the household). Static Web Apps' built-in sign-in isn't used: on the Free plan the API is a separate Functions app that never sees it.

Do these before merging card F4's pull request, or just after it. Until they're done, the API refuses every request that needs sign-in with 500, the web app says sign-in isn't set up, and each Dev deploy ends with a warning. Run them in bash (Git Bash works), signed in to the Azure CLI as the subscription owner. For Prod, repeat with `prod` in place of `dev`.

1. Create the app registration `kitchen-dev`: this tenant only, the web app's address, its MSAL redirect bridge (`/redirect.html`, which silent token renewal returns to) and Vite's local server as single-page-app redirect URIs, and an API scope `access_as_user` that issues v2 tokens (the API rejects v1 tokens).

   Copy this block as it is (the heredoc's closing `EOF` must start its line):

```bash
web=$(az staticwebapp list -g rg-kitchen-dev --query "[0].defaultHostname" -o tsv)
app=$(az ad app create --display-name kitchen-dev --sign-in-audience AzureADMyOrg --query appId -o tsv)
obj=$(az ad app show --id "$app" --query id -o tsv)
scope=$(powershell -NoProfile -Command '[guid]::NewGuid().ToString()' | tr -d '\r')
cat > kitchen-app.json <<EOF
{
  "identifierUris": ["api://$app"],
  "spa": { "redirectUris": ["https://$web/", "https://$web/redirect.html", "http://localhost:5173/", "http://localhost:5173/redirect.html"] },
  "api": {
    "requestedAccessTokenVersion": 2,
    "oauth2PermissionScopes": [{
      "id": "$scope", "value": "access_as_user", "type": "User", "isEnabled": true,
      "adminConsentDisplayName": "Use the kitchen app",
      "adminConsentDescription": "Lets the kitchen web app call the kitchen API as you.",
      "userConsentDisplayName": "Use the kitchen app",
      "userConsentDescription": "Lets the kitchen web app call the kitchen API as you."
    }]
  }
}
EOF
az rest --method PATCH --uri "https://graph.microsoft.com/v1.0/applications/$obj" \
  --headers Content-Type=application/json --body @kitchen-app.json
rm kitchen-app.json
az ad sp create --id "$app"
```

   Leave `http://localhost:5173/` out for Prod. In the portal instead: **Entra ID**, **App registrations**, **New registration** (this directory only; platform **Single-page application** with both redirect URIs). Then **Expose an API**: set the Application ID URI to `api://<client id>` and add the scope `access_as_user` (admins and users can consent). Then in **Manifest**, set `requestedAccessTokenVersion` to `2`.

2. Give the pipeline the client ID. It isn't secret; it ends up in the web app's `config.json`:

   ```bash
   gh variable set KITCHEN_AUTH_CLIENT_ID --env dev --body "$app"
   ```

3. Put yourself in the household. Your object ID stays out of git and out of the public Actions logs: it's the `household-members` Key Vault secret, which the API reads through a Key Vault reference. You need Key Vault Secrets Officer on the vault (see "Secrets you add by hand").

   ```bash
   vault=$(az keyvault list -g rg-kitchen-dev --query "[0].name" -o tsv)
   az keyvault secret set --vault-name "$vault" --name household-members --value "$(az ad signed-in-user show --query id -o tsv)"
   ```

   To add someone later, set the secret to both object IDs separated by a comma, then restart the Functions app (`az functionapp restart -g rg-kitchen-dev -n <function app>`) so it reads the new value. Otherwise Azure refreshes Key Vault references only about once a day.

4. Merge, or rerun **Deploy Dev**. The deploy writes the client ID into `config.json`, and its check fails unless `/api/me` answers 401 to a request without a token. Then open the web app: **Sign in with Microsoft** should show your name and household, and a private window signed in with another account should be refused.

## Prod (one time)

Prod is `environments/prod/`: the same module as Dev, in `rg-kitchen-prod` (`centralus`), with its own free-tier database, Key Vault, Functions app and Static Web App. It differs from Dev in four ways: the API accepts no `localhost` origin; the SQL admin is `kitchen-github-prod`; the Key Vault has purge protection on, because it holds the Plaid Production secret; and it has storage for the weekly database export (see "Backups"). Once on, purge protection can't be turned off, and a deleted vault can't be purged before its 7 days are up. Prod's tests (`environments/prod/tests`) pin these choices.

The bootstrap already made `rg-kitchen-prod`, the `kitchen-github-prod` identity, the `tfstate-prod` state container and the `prod` GitHub Environment with its `AZURE_*` variables, and step 5 above made the environment wait for you. Then:

1. **First apply.** In GitHub, **Actions → Deploy Prod → Run workflow** on `main`. The build runs, then the deploy job waits: open the run, choose **Review deployments**, tick `prod` and approve. It applies Prod's Terraform (several minutes the first time; the SQL server is the slowest part), migrates the empty database, deploys both apps and checks them. Sign-in isn't set up yet, so the run ends with a warning about it. That's expected.

2. **Sign-in.** Do the three steps under "Sign-in" above with `prod` in place of `dev` (`rg-kitchen-prod`, `--env prod`, Prod's vault):
   1. Create the app registration `kitchen-prod`, with the Prod web app's address and its redirect bridge as its only redirect URIs. Leave out the `http://localhost:5173/` ones: in the JSON, `"redirectUris": ["https://$web/", "https://$web/redirect.html"]`.
   2. Run `gh variable set KITCHEN_AUTH_CLIENT_ID --env prod --body "$app"`.
   3. Put your object ID in Prod's `household-members` secret. Give yourself Key Vault Secrets Officer on Prod's vault first.

3. **Plaid.** Put the Plaid **Production** keys in Prod's vault. Dev keeps the Sandbox ones. The values go nowhere but the vault:

   ```bash
   vault=$(az keyvault list -g rg-kitchen-prod --query "[0].name" -o tsv)
   az keyvault secret set --vault-name "$vault" --name plaid-client-id --value "$(read -rsp 'Plaid client ID: ' v; echo "$v")"
   az keyvault secret set --vault-name "$vault" --name plaid-secret --value "$(read -rsp 'Plaid Production secret: ' v; echo "$v")"
   ```

4. **Deploy again** (Run workflow, then approve). This time `/api/me` must answer 401 or the run fails. Then open the Prod web app and sign in.

### Deploying to Prod

- **By hand:** **Actions → Deploy Prod → Run workflow**, branch `main`. A run on any other branch is refused before anything signs in.
- **By release tag:** tag a commit that's already on `main` and push the tag, for example `git tag v1.0.0 origin/main && git push origin v1.0.0`. The workflow refuses a tag on a commit that isn't on `main`. Tag runs need the `v*` tag rule on the `prod` environment (step 5 of the bootstrap); without it, GitHub refuses them at the environment. One caveat: a tag run uses the workflow file from the tagged commit, so the "is it on main" check only protects you if that commit's workflow has it. Someone with write access could tag an off-main commit whose workflow doesn't check. You'd still have to approve the run, so check the commit on the approval page before you approve a tag run. To close the gap, add a tag ruleset (**Settings → Rules → Rulesets**, target tags `v*`) that only you can bypass for creating tags, or skip the `v*` rule and deploy by hand only.

Either way, the run builds and tests the commit, then waits for your approval before the one job that signs in to Azure. Apply, migrate and deploy share that job, so one approval covers the whole deploy (GitHub asks again for each job that names a protected environment). The approval page doesn't show a Terraform plan. To see what will change, look at Dev's apply for the same commit, since both use the same module, or watch the plan step's log as the job runs. A newer run replaces one still waiting for approval; a running deploy is never cancelled.

## Backups

Prod's data has two copies besides the live database (ADR-25, card S2):

| | Point-in-time restore | Weekly export |
|---|---|---|
| What | Azure SQL's automatic backups (full, differential and log) | A `.bacpac` of the whole database, made by SqlPackage |
| How far back | Any moment in the last **7 days** | The newest **8** Sunday exports, about two months |
| Where | Azure's backup storage, locally redundant, tied to the server | Blob container `database-exports` in `stkitchenbakprod<suffix>`, in `rg-kitchen-prod` |
| Survives a deleted database | Yes, for 7 days (restore it as a deleted database) | Yes |
| Survives a deleted server | No | Yes |
| Survives a deleted resource group | No | No |
| Cost | Free (the free offer includes 32 GB of backup storage) | Cents a month of blob storage |

**Point-in-time retention is 7 days and can't be raised.** This was checked, not assumed. Dev's database uses the same module and free offer, and in November 2026 `az sql db str-policy show` reported `retentionDays: 7`, `az sql db show` reported backup redundancy `Local`, and the earliest restore point was about a week back. The free offer FAQ agrees: with "Auto-pause the database until next month", point-in-time retention is limited to seven days, long-term retention isn't available, and backups are locally redundant. Check Prod's own values with:

```bash
srv=$(az sql server list -g rg-kitchen-prod --query "[0].name" -o tsv)
az sql db str-policy show -g rg-kitchen-prod -s "$srv" -n sqldb-kitchen-app --query retentionDays
az sql db show -g rg-kitchen-prod -s "$srv" -n sqldb-kitchen-app --query earliestRestoreDate
```

### How the weekly export works

The **Backup Prod** workflow (`.github/workflows/backup-prod.yml`) runs every Sunday at 07:17 UTC. You can also start it from **Actions → Backup Prod → Run workflow** on `main`. Each run counts as one of the 8, so extra runs by hand shorten how far back the exports go. It runs `infra/scripts/export-database.sh`, which:

1. exports `sqldb-kitchen-app` with SqlPackage
2. checks the file is a bacpac
3. uploads it as `sqldb-kitchen-app/sqldb-kitchen-app-<yyyymmddThhmmssZ>.bacpac`
4. only then deletes all but the newest 8

When a run fails, GitHub emails whoever last changed the schedule, as it does for any failed scheduled run.

The export account accepts Entra sign-in only, with no account keys. It keeps blob **versions**, and keeps deleted blobs and containers **soft-deleted for 30 days**. A lifecycle rule deletes old versions after 30 days, so storage stays at about 8 exports. For 30 days you can bring back an export the job pruned, or one deleted by mistake, from **Versions** or **Show deleted blobs** in the portal.

Why SqlPackage, run from GitHub Actions:

- Azure's own export (`az sql db export`, the Import/Export service) can sign in two ways, and neither fits. One is a SQL password, which this server refuses (Entra only). The other is a user-assigned managed identity that must be the server's Entra admin, which would replace `kitchen-github-prod` as admin, and that option is still in preview.
- SqlPackage signs in with an Entra access token, works on the free offer, and is what Microsoft recommends for automated exports.
- GitHub Actions is free for this public repository and already signs in with OIDC. So nothing new runs in Azure and no secret is stored anywhere.

The export reads the live database, so it's only transactionally consistent if nothing writes during the minute it takes. That's why it runs at 07:17 UTC on a Sunday, and point-in-time restore covers anything it misses. Exporting from a copy would avoid this, but the free offer can't be copied.

The export wakes the paused database, retrying while Azure answers error 40613, and uses a little of the month's free vCore allowance. If the allowance has run out and the database is paused until next month, that week's export fails.

### Why it doesn't use the `prod` environment

Every job in the `prod` GitHub Environment waits for your approval, so a scheduled job there would sit waiting every Sunday. Instead of loosening that rule, the export has its own environment and identity, with far less power:

- **The `prod-backup` GitHub Environment** has no required reviewer and accepts runs from `main` only. Only the schedule and people with write access can start the workflow, and no pull request reaches it.
- **The `kitchen-github-prod-backup` identity** is created by the bootstrap. Its only credential trusts `environment:prod-backup`, and it has no Azure role on any resource or resource group. It gets two rights:
  - **Storage Blob Data Contributor on the `database-exports` container**, granted by Prod's Terraform. It can add, read and delete blobs, but it can't delete versions, so it can't destroy the 30-day history.
  - **`db_datareader` and `VIEW DEFINITION`** as a database user (`packages/db/sql/backup-reader.sql`), created by the Deploy Prod migration step. CI shows that's enough for SqlPackage and gives no write access, on SQL Server 2022 with a SQL login standing in for the Entra user. The first run in Azure (step 4 below) confirms it there.

If this identity were stolen, the worst it could do is read the Prod database, as anyone holding a backup could, and delete the current exports, which you could still recover for 30 days.

### Turn it on (one time)

After this card's pull request is merged:

1. **Apply the bootstrap again.** This creates the backup identity and lets the Prod deploy identity grant its one role. Run it from `infra/bootstrap`, signed in as the subscription owner, as in "Bootstrap" above:

   ```bash
   cd infra/bootstrap
   terraform plan -out=tfplan
   terraform apply tfplan
   ./configure-github.sh
   ```

   The plan adds `kitchen-github-prod-backup` and its federated credential, and updates the deploy identities' role-assignment condition. Nothing is destroyed.

   `configure-github.sh` then does three things:
   - creates the `prod-backup` environment, with no reviewer and `main` only
   - sets that environment's `AZURE_*` variables
   - sets `AZURE_BACKUP_PRINCIPAL_ID` and `AZURE_BACKUP_CLIENT_ID` on `prod`

   In **Settings → Environments → prod-backup**, check that "Deployment branches and tags" shows `main` only and there are no required reviewers.

2. **Deploy Prod** (Run workflow, then approve). Terraform creates the export storage and grants the container, and the migration step creates the `kitchen-github-prod-backup` database user. The run's summary lists `exports_storage_account_name`.

3. **Tell the backup job where to look.** These are names only, nothing secret:

   ```bash
   gh variable set KITCHEN_SQL_SERVER --env prod-backup --body "$(az sql server list -g rg-kitchen-prod --query "[0].fullyQualifiedDomainName" -o tsv)"
   gh variable set KITCHEN_EXPORTS_STORAGE_ACCOUNT --env prod-backup --body "$(az storage account list -g rg-kitchen-prod --query "[?tags.purpose=='database-exports'].name | [0]" -o tsv)"
   ```

4. **Run it once by hand:** **Actions → Backup Prod → Run workflow** on `main`. It shouldn't ask for approval. Its summary shows the new export and how many are kept.

5. **Do the restore drill** below once, before the switch-over (card S3).

GitHub turns off scheduled workflows in a public repository after 60 days without a commit. If that happens, GitHub emails you and the Actions tab shows the workflow as disabled. Turn it back on there.

### Restore drill: a weekly export into a scratch database

This is the card's `[Adam] Verify` step, and also how to look inside any export. It builds a throwaway server with you as its only admin, imports an export into a free database there, and deletes it all afterwards. It touches nothing in Prod.

Run it in bash (Git Bash works) from the repository root, signed in to the Azure CLI as the subscription owner. SqlPackage needs the .NET 8 SDK or later.

```bash
export MSYS_NO_PATHCONV=1   # Git Bash: stops it rewriting SqlPackage's /Options as paths
dotnet tool restore         # installs the pinned SqlPackage (.config/dotnet-tools.json)
rg=rg-kitchen-prod
acct=$(az storage account list -g $rg --query "[?tags.purpose=='database-exports'].name | [0]" -o tsv)
me=$(az ad signed-in-user show --query id -o tsv)
upn=$(az ad signed-in-user show --query userPrincipalName -o tsv)
bacpac=$(cygpath -w ~/restore.bacpac 2>/dev/null || echo ~/restore.bacpac)   # Git Bash: a Windows path, which az and SqlPackage need under MSYS_NO_PATHCONV
# The export holds real data and the repository is public: keep the file in your home folder, never in the repo.

# 1. Give yourself read access to the exports. An Owner can't read blobs without a data role.
#    The role can take up to about 10 minutes to apply. If step 2 says you lack the
#    "required permissions", wait a few minutes and retry.
container_id="$(az storage account show -g $rg -n "$acct" --query id -o tsv)/blobServices/default/containers/database-exports"
az role assignment create --role "Storage Blob Data Reader" --assignee-object-id "$me" --assignee-principal-type User --scope "$container_id"

# 2. List the exports, then download one (the newest here).
az storage blob list --auth-mode login --account-name "$acct" -c database-exports --prefix sqldb-kitchen-app/ \
  --query "[].{name:name, bytes:properties.contentLength}" -o table
blob=$(az storage blob list --auth-mode login --account-name "$acct" -c database-exports --prefix sqldb-kitchen-app/ --query "sort_by([], &name)[-1].name" -o tsv)
az storage blob download --auth-mode login --account-name "$acct" -c database-exports -n "$blob" -f "$bacpac"

# 3. Create a scratch server with you as its only admin, open it to your IP, and add an empty free database.
scratch=sql-kitchen-restore-$RANDOM
az sql server create -g $rg -n "$scratch" -l centralus --enable-ad-only-auth \
  --external-admin-principal-type User --external-admin-name "$upn" --external-admin-sid "$me"
ip=$(curl -s https://api.ipify.org)
az sql server firewall-rule create -g $rg -s "$scratch" -n restore-drill --start-ip-address "$ip" --end-ip-address "$ip"
az sql db create -g $rg -s "$scratch" -n kitchen-restore -e GeneralPurpose -f Gen5 -c 2 --compute-model Serverless \
  --use-free-limit --free-limit-exhaustion-behavior AutoPause --backup-storage-redundancy Local

# 4. Import the export into it, signed in as you.
token=$(az account get-access-token --resource https://database.windows.net/ --query accessToken -o tsv)
dotnet tool run sqlpackage /Action:Import /SourceFile:"$bacpac" \
  /TargetServerName:"$scratch.database.windows.net" /TargetDatabaseName:kitchen-restore /AccessToken:"$token"
```

5. **Open it.** In the portal, open the `kitchen-restore` database, choose **Query editor** and sign in with Entra. Or connect VS Code's SQL Server extension to `<scratch>.database.windows.net` with Microsoft Entra ID. Check that the data you'd miss is there:

   ```sql
   SELECT (SELECT COUNT(*) FROM recipe) AS recipes, (SELECT COUNT(*) FROM product) AS products,
          (SELECT MAX(applied_at) FROM schema_migration) AS last_migration;
   ```

6. **Clean up.** The free database costs nothing, but remove it all:

   ```bash
   az sql server delete -g $rg -n "$scratch" --yes
   az role assignment delete --assignee "$me" --role "Storage Blob Data Reader" --scope "$container_id"
   rm ~/restore.bacpac
   ```

The free offer allows 10 free databases per subscription, all in one region (`centralus`), and Dev and Prod use two. If `az sql db create` refuses `--use-free-limit`, leave out the two free options and add `--auto-pause-delay 60` instead. That database is serverless and billed by the second, a few cents for a drill, so delete it straight after.

### Point-in-time restore

Use this for "it was fine yesterday". It restores Prod's database as it was at a moment in the last 7 days into a new database on the same server, and leaves the live database alone. A restored database can't be on the free offer, so it's billed until you delete it: serverless, by the second, a few cents an hour while in use.

```bash
rg=rg-kitchen-prod
srv=$(az sql server list -g $rg --query "[0].name" -o tsv)
az sql db show -g $rg -s "$srv" -n sqldb-kitchen-app --query earliestRestoreDate   # how far back you can go

az sql db restore -g $rg -s "$srv" -n sqldb-kitchen-app --dest-name sqldb-kitchen-pitr \
  --time <yyyy-mm-ddThh:mm:ssZ> \
  -e GeneralPurpose -f Gen5 -c 1 --compute-model Serverless --auto-pause-delay 60 --backup-storage-redundancy Local
```

Set `--time` to the moment you want, in UTC, no earlier than `earliestRestoreDate`. A database deleted in the last 7 days shows up in `az sql db list-deleted -g $rg -s "$srv"`. Restore it the same way, adding `--deleted-time` from that list.

Only `kitchen-github-prod` can sign in to Prod's server. To look inside the restored copy, copy it to a scratch server where you're the admin. First set the drill's variables (the lines before step 1), and do its step 3 without the `az sql db create` line. Then run:

```bash
az sql db copy -g $rg -s "$srv" -n sqldb-kitchen-pitr --dest-server "$scratch" --dest-name kitchen-pitr
az sql db delete -g $rg -s "$srv" -n sqldb-kitchen-pitr --yes   # the copy on Prod's server isn't needed any more
```

Open `kitchen-pitr` as in step 5 of the drill. To put it back into Prod (below), export it to a bacpac first:

```bash
token=$(az account get-access-token --resource https://database.windows.net/ --query accessToken -o tsv)
dotnet tool run sqlpackage /Action:Export /SourceServerName:"$scratch.database.windows.net" /SourceDatabaseName:kitchen-pitr \
  /AccessToken:"$token" /TargetFile:"$bacpac"
```

Delete the scratch server and `~/restore.bacpac` when you're done.

### Putting a backup back into Prod

Do this only if Prod's data is lost or wrong and the app must run on the restored data. You need a bacpac with the data you want: a weekly export, or a point-in-time copy exported as above. The variables are the ones from the drill.

1. Rename the damaged database out of the way, and keep it until you're sure:

   ```bash
   az sql db rename -g $rg -s "$srv" -n sqldb-kitchen-app --new-name sqldb-kitchen-app-damaged
   ```

2. Create an empty free database with the app database's name and the settings Terraform gives it:

   ```bash
   az sql db create -g $rg -s "$srv" -n sqldb-kitchen-app -e GeneralPurpose -f Gen5 -c 2 --compute-model Serverless \
     --use-free-limit --free-limit-exhaustion-behavior AutoPause --auto-pause-delay 60 --min-capacity 0.5 \
     --max-size 32GB --backup-storage-redundancy Local --zone-redundant false --tags app=kitchen environment=prod managed_by=terraform
   ```

3. Import the bacpac into it. Only the server's admin can, and that's `kitchen-github-prod`, so make yourself admin for the import. This locks the pipeline out of the database until step 4, so don't deploy anything else in between. Prod's firewall lets in Azure services only, so also let in your IP for the import, and remove it afterwards.

   ```bash
   az sql server ad-admin create -g $rg -s "$srv" --display-name "$upn" --object-id "$me"
   ip=$(curl -s https://api.ipify.org)
   az sql server firewall-rule create -g $rg -s "$srv" -n restore-import --start-ip-address "$ip" --end-ip-address "$ip"
   token=$(az account get-access-token --resource https://database.windows.net/ --query accessToken -o tsv)
   dotnet tool run sqlpackage /Action:Import /SourceFile:"$bacpac" \
     /TargetServerName:"$srv.database.windows.net" /TargetDatabaseName:sqldb-kitchen-app /AccessToken:"$token"
   az sql server firewall-rule delete -g $rg -s "$srv" -n restore-import
   ```

   The bacpac brings its database users with it, such as `kitchen-github-prod-backup`, so they work again without being recreated.

4. **Deploy Prod** (Run workflow, then approve). Terraform makes `kitchen-github-prod` the admin again and brings the new database's settings in line (check the plan step's log: it should update the database in place, never replace it). The migrations add anything newer than the backup, and the backup user is checked. Open the app and check the data.

5. When you're sure, delete `sqldb-kitchen-app-damaged`. It's free, but it uses one of the subscription's 10 free databases.

## Warehouse

dbt builds the `marts` schema inside each environment's app database every night (ADR-28, card W1). `warehouse/README.md` describes the project. Like the backup, it runs as an identity of its own, `kitchen-github-<env>-warehouse`, in a GitHub Environment of its own, `<env>-warehouse`. That environment has no reviewer, because a scheduled job can't wait for one, and allows `main` only. The identity can:

- read the tables in `dbo` except the bank connections (`plaid_*`) and `user.entra_object_id`, and write none of them
- own the `marts` schema and create tables and views there, and nowhere else (`packages/db/sql/warehouse-builder.sql`, granted by the Deploy Dev migration step)
- read the one Key Vault secret `ntfy-topic`, for the failure alert. The role is scoped to that secret, not the vault.

It has no Azure role on the subscription, the resource group or the SQL server, and it can't deploy anything. Only Dev has one for now. Prod comes later: add `"prod"` to `warehouse_environments` in `infra/bootstrap/main.tf` and to the workflow's matrix, then wire Deploy Prod the way Deploy Dev is wired.

### Turn it on (one time)

After the W1 pull request is merged:

1. **Check that `ntfy-topic` is in Dev's main vault** (see "Secrets you add by hand"). The role assignment is scoped to that secret, so Azure may refuse it if the secret doesn't exist yet.

2. **Apply the bootstrap again.** This creates the warehouse identity. Run it from `infra/bootstrap`, signed in as the subscription owner:

   ```bash
   cd infra/bootstrap
   terraform plan -out=tfplan
   terraform apply tfplan
   ./configure-github.sh
   ```

   The plan adds `kitchen-github-dev-warehouse`, its service principal and its federated credential. Nothing changes or is destroyed.

   `configure-github.sh` then:
   - creates the `dev-warehouse` environment, with no reviewer and `main` only
   - sets that environment's `AZURE_CLIENT_ID` and `AZURE_TENANT_ID`
   - sets `AZURE_WAREHOUSE_PRINCIPAL_ID` and `AZURE_WAREHOUSE_CLIENT_ID` on `dev`

   In **Settings → Environments → dev-warehouse**, check that "Deployment branches and tags" shows `main` only and there are no required reviewers.

3. **Run Deploy Dev** (**Actions → Deploy Dev → Run workflow** on `main`). Terraform grants the identity read access to `ntfy-topic`. The migration step creates the `kitchen-github-dev-warehouse` database user and the `marts` schema, and grants the user its rights. The log says "kitchen-github-dev-warehouse can read the app's tables and build marts."

4. **Tell the build where to look.** These are names only, nothing secret:

   ```bash
   gh variable set KITCHEN_SQL_SERVER --env dev-warehouse --body "$(az sql server list -g rg-kitchen-dev --query "[0].fullyQualifiedDomainName" -o tsv)"
   gh variable set KITCHEN_KEY_VAULT_NAME --env dev-warehouse --body "$(az keyvault list -g rg-kitchen-dev --query "[?!ends_with(name, '-t')].name | [0]" -o tsv)"
   ```

   The vault name is also the `key_vault_name` output in a Deploy Dev run's summary.

5. **Run it once by hand:** **Actions → Warehouse nightly → Run workflow** on `main`. Run it once with *dry run* ticked, then once without. Neither should ask for approval. The real run's summary counts the models built and tests passed. A failed run sends its alert to the same ntfy topic as the bank sync.

The build wakes the free-tier database every night and uses some of its monthly vCore allowance (ADR-28, "Consequences"). Keep an eye on it in the portal (the database, **Compute utilization**) as data grows.

## Pipeline

Five workflows. All of them sign in to Azure with OIDC, as the environment's deploy identity or (Backup Prod, Warehouse nightly) an identity of their own, so no Azure key or secret exists in GitHub.

- **`Infrastructure`** runs when a change touches `infra/` or the workflow itself.
  - Pull requests and pushes to `main`: `terraform fmt`, `validate` on every root, the bootstrap's, module's and Prod root's tests (`terraform test` with mocked providers, so no Azure sign-in), and the API deploy and export scripts' tests (fake `az`, `curl` and `sqlpackage`). Prod is never planned on a pull request.
  - The same events also run the export for real. SqlPackage exports a test database from a throwaway SQL Server, signed in with only the backup reader's grants; the export is imported into a scratch database and compared with the original. Only blob storage is faked, and nothing signs in to Azure.
  - Pull requests from branches in this repository: a Dev `terraform plan`, shown in the job's summary. It never applies.
- **`Deploy Dev`** runs when a change touches `apps/`, `packages/`, the environment Terraform, the root build files or the workflow itself. It can also be started by hand on `main`.
  - Pull requests: a dry run. It builds and tests the web app and API, packages them exactly as a deploy would, and checks the packages. It signs in to nothing.
  - Merge to `main`: plan and apply Dev's Terraform, then deploy the API (zip to the Flex Consumption publish endpoint, retried while a new app's endpoint refuses it) and the web app (Static Web Apps, with a `config.json` pointing at the API), then check that `/api/health` answers, `/api/me` refuses a request without a token (401), the web app loads and the API allows the web app's origin.
- **`Deploy Prod`** runs only when started by hand on `main`, or on a `v*` tag of a commit on `main` (see "Deploying to Prod"). It builds with the same steps as Deploy Dev (`.github/actions/build-kitchen`), waits for your approval in the `prod` environment, then applies, migrates, deploys and checks Prod with the same scripts (`infra/scripts`). It never runs on a pull request.
- **`Backup Prod`** runs every Sunday, and when started by hand on `main`. It runs in the `prod-backup` environment as `kitchen-github-prod-backup`, with no approval, exports Prod's database and keeps the newest 8 exports (see "Backups"). It never runs on a pull request.

- **`Warehouse nightly`** runs every day at 08:40 UTC, and when started by hand on `main`. It runs in `dev-warehouse` as `kitchen-github-dev-warehouse`, with no approval. It runs `dbt build` against Dev's database and sends a phone alert through ntfy when the build fails (see "Warehouse"). On pull requests, and when started with *dry run* ticked, it does a dry run that signs in to nothing. The pull request workflow also runs `dbt build` against a throwaway SQL Server with fixture data.

The repository is public (ADR-30), so only jobs for branches in this repository run in the `dev` GitHub Environment, the only place the Dev deploy identity can sign in. Pull requests from forks get the Terraform checks and the build only. No pull request of any kind reaches the `prod`, `prod-backup` or `dev-warehouse` environment. Deploy Prod and Backup Prod have no pull request trigger. Warehouse nightly's pull request run is the dry run, which uses no environment. Only people with write access (and the schedules) can start them or push tags. No workflow uses `pull_request_target`.

The first merge with these workflows runs the first apply, which creates the Dev resources. That takes several minutes; the SQL server is the slowest part.

## Run it locally

```bash
terraform -chdir=infra/bootstrap init -backend=false
terraform -chdir=infra/bootstrap validate
terraform -chdir=infra/bootstrap test

terraform -chdir=infra/modules/environment init -backend=false
terraform -chdir=infra/modules/environment test

terraform -chdir=infra/environments/prod init -backend=false
terraform -chdir=infra/environments/prod test

bash infra/scripts/tests/deploy-api.test.sh
bash infra/scripts/tests/export-database.test.sh
```

The export's integration test also needs a SQL Server and SqlPackage (`dotnet tool restore`, then `SQLPACKAGE="dotnet tool run sqlpackage"`). Run it on Linux or in a container, because Git Bash rewrites SqlPackage's `/Options` as paths. The comment at the top of `infra/scripts/tests/export-database.integration.sh` and the `export-test` job in `.github/workflows/infrastructure.yml` show how.

The module's tests pin what keeps an environment free and locked down: the Free web plan; Flex Consumption on Node 24 with identity-based storage and no always-ready instances; Key Vault RBAC with the API able to read secrets; the SQL free offer that pauses instead of billing; Entra-only SQL sign-in with the deploy identity as admin and an Azure-services-only firewall; the API told which database to use, with its identity's client ID read for its database user; workspace-based Application Insights with the free retention and a small daily cap; and localhost allowed only in Dev. Prod's tests pin that Prod uses `rg-kitchen-prod` in `centralus`, with its own free database administered by `kitchen-github-prod`, a purge-protected Key Vault and no localhost origin.

The tests also pin the weekly export's storage and rights:

- the module's: Entra sign-in only, versioning, soft delete, a private container, old versions kept 30 days, and Storage Blob Data Contributor (never Owner) for the backup identity alone
- Prod's: Prod turns exports on, and grants them to the backup identity, not the deploy identity
- the bootstrap's: the backup identity trusts `prod-backup` only, and the deploy identity may grant Storage Blob Data Contributor but never Owner
