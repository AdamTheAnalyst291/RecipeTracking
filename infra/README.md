# Infrastructure

Terraform for the kitchen app's Azure environments (ADR-25). It is copied from Setlist's `infra/` and adapted.

| Path | What it is | Who applies it |
|---|---|---|
| `bootstrap/` | One-time setup: Terraform state storage, each environment's resource group and GitHub deploy identity, and the kitchen's budget alert | The subscription owner, by hand |
| `modules/environment/` | One environment: web app, API, Key Vault and app database | Used by the roots below |
| `environments/dev/` | Dev, in `rg-kitchen-dev` | GitHub Actions, on every merge to `main` |

Prod gets its own root (`environments/prod/`) and an approval-gated deploy in a later card.

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
   - registrations for the resource providers the kitchen app uses (Setlist's bootstrap registers the same ones; registering again is harmless)
   - `rg-kitchen-tfstate` with a storage account `stkitchentf<suffix>` (Standard LRS, Entra ID access only, versioning and 7-day soft delete) and one container per environment: `tfstate-dev`, `tfstate-prod`
   - per environment (`dev`, `prod`): `rg-kitchen-<env>`, and an app registration `kitchen-github-<env>` whose only credential is a federated credential for `repo:AdamTheAnalyst291@225034465/RecipeTracking@1433625977:environment:<env>`. GitHub puts immutable owner and repository IDs in this repository's OIDC subject, so the trust can't pass to a renamed or recreated repo
   - role assignments for that identity: Contributor on its resource group; Role Based Access Control Administrator on its resource group, limited to granting Storage Blob Data Owner and Key Vault Secrets User; Storage Blob Data Contributor on its own state container
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

   This sets the repository variables `TF_STATE_RESOURCE_GROUP` and `TF_STATE_STORAGE_ACCOUNT`, and on each environment `AZURE_CLIENT_ID`, `AZURE_PRINCIPAL_ID`, `AZURE_TENANT_ID` and `AZURE_SUBSCRIPTION_ID`. It creates an environment only if it's missing, so rerunning it leaves protection rules alone.

5. Make Prod wait for you: in GitHub, **Settings → Environments → prod**, tick **Required reviewers**, add yourself, and under **Deployment branches and tags** allow `main` only, then save. Every Prod deploy then waits for your approval. The repository is public, so GitHub Free offers required reviewers (ADR-30).

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
- **Azure SQL:** a server that accepts Microsoft Entra sign-in only, with the environment's deploy identity (`kitchen-github-<env>`) as its admin so the pipeline can run migrations, and a firewall that lets in Azure services only. Its database uses the free offer and pauses for the rest of the month instead of billing when the free allowance runs out.

Names carry a suffix derived from the subscription, environment and region, so they stay the same from run to run. The Deploy Dev run's summary lists them.

## Secrets you add by hand

Secrets go in the environment's Key Vault, never in git, GitHub or app settings. Terraform and the deploy identity never handle secret values, so you add them yourself, signed in as the subscription owner. First give yourself **Key Vault Secrets Officer** on the vault (portal: the vault, **Access control (IAM)**, **Add role assignment**): an RBAC vault doesn't let even an Owner read or write secrets without a data role.

| Secret name | What it is | Used by |
|---|---|---|
| `plaid-client-id` | Plaid client ID | Bank sync (cards $0 and $2) |
| `plaid-secret` | Plaid secret for the Plaid environment Dev uses | Bank sync (cards $0 and $2) |

Add or update one in the portal (the vault, **Objects**, **Secrets**, **Generate/Import**), or with the Azure CLI. Reading the value from a prompt keeps it out of your shell history:

```bash
vault=$(az keyvault list -g rg-kitchen-dev --query "[0].name" -o tsv)
az keyvault secret set --vault-name "$vault" --name plaid-client-id --value "$(read -rsp 'Plaid client ID: ' v; echo "$v")"
az keyvault secret set --vault-name "$vault" --name plaid-secret --value "$(read -rsp 'Plaid secret: ' v; echo "$v")"
```

In PowerShell: `az keyvault secret set --vault-name $vault --name plaid-secret --value (Read-Host 'Plaid secret')`.

## Pipeline

Two workflows. Both sign in to Azure with OIDC as the environment's deploy identity, so no Azure key or secret exists in GitHub.

- **`Infrastructure`** runs when a change touches `infra/` or the workflow itself.
  - Pull requests and pushes to `main`: `terraform fmt`, `validate` on every root, and the bootstrap's and module's tests (`terraform test` with mocked providers, so no Azure sign-in).
  - Pull requests from branches in this repository: a Dev `terraform plan`, shown in the job's summary. It never applies.
- **`Deploy Dev`** runs when a change touches `apps/`, `packages/`, the environment Terraform, the root build files or the workflow itself. It can also be started by hand on `main`.
  - Pull requests: a dry run. It builds and tests the web app and API, packages them exactly as a deploy would, and checks the packages. It signs in to nothing.
  - Merge to `main`: plan and apply Dev's Terraform, then deploy the API (zip to the Flex Consumption publish endpoint) and the web app (Static Web Apps, with a `config.json` pointing at the API), then check that `/api/health` answers, the web app loads and the API allows the web app's origin.

The repository is public (ADR-30), so only jobs for branches in this repository run in the `dev` GitHub Environment, the only place the Dev deploy identity can sign in. Pull requests from forks get the Terraform checks and the build only. Neither workflow uses `pull_request_target`.

The first merge with these workflows runs the first apply, which creates the Dev resources. That takes several minutes; the SQL server is the slowest part.

## Run it locally

```bash
terraform -chdir=infra/bootstrap init -backend=false
terraform -chdir=infra/bootstrap validate
terraform -chdir=infra/bootstrap test

terraform -chdir=infra/modules/environment init -backend=false
terraform -chdir=infra/modules/environment test
```

The module's tests pin what keeps an environment free and locked down: the Free web plan; Flex Consumption on Node 24 with identity-based storage and no always-ready instances; Key Vault RBAC with the API able to read secrets; the SQL free offer that pauses instead of billing; Entra-only SQL sign-in with the deploy identity as admin and an Azure-services-only firewall; and localhost allowed only in Dev.
