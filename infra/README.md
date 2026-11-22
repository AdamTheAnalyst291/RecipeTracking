# Infrastructure

Terraform for the kitchen app's Azure environments (ADR-25). It is copied from Setlist's `infra/` and adapted. Only the bootstrap exists so far; card F3 adds the environment module and the deploy to Dev.

| Path | What it is | Who applies it |
|---|---|---|
| `bootstrap/` | One-time setup: Terraform state storage, each environment's resource group and GitHub deploy identity, and the kitchen's budget alert | The subscription owner, by hand |

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

5. Make Prod wait for you: in GitHub, **Settings → Environments → prod**, tick **Required reviewers**, add yourself and save. Every Prod deploy then waits for your approval. (GitHub offers required reviewers on private repositories only on some plans; if the box isn't offered, note it on card F3 before the Prod deploy is built.)

6. Move Setlist's budget off the whole subscription (see below).

## Re-scope Setlist's budget (one time)

Setlist's `setlist-monthly` budget ($5) was created by Setlist's own bootstrap for the whole subscription, so it would also count the kitchen's spend. Limit it to Setlist's resource groups. In the Azure portal:

1. **Cost Management → Budgets**, scope **My-VibeCode**, open `setlist-monthly` and choose **Edit budget**.
2. Under **Filters**, add **Resource group name** and pick `rg-setlist-tfstate` and every `rg-setlist-<env>` group that exists (today `rg-setlist-dev`).
3. Save. The amount and alert emails stay as they are.

Setlist's bootstrap doesn't set a filter, so its next `terraform plan` there will show the filter being removed. Before applying Setlist's bootstrap again, add the same `filter` block to its `azurerm_consumption_budget_subscription.monthly` (this module's `kitchen` budget shows the shape), so the change sticks.

## Adding UAT later

Set `environments = ["dev", "uat", "prod"]` in `terraform.tfvars`, apply again, and rerun `./configure-github.sh`. The budget picks up the new resource group on its own.

## Pipeline

The `Infrastructure` workflow runs on pull requests and pushes to `main` that touch `infra/` or the workflow itself. It checks `terraform fmt`, runs `terraform validate` on the bootstrap, and runs its tests (`terraform test`, with mocked providers, so no Azure sign-in). F3 adds the Dev plan and apply.

## Run it locally

```bash
terraform -chdir=infra/bootstrap init -backend=false
terraform -chdir=infra/bootstrap validate
terraform -chdir=infra/bootstrap test
```
