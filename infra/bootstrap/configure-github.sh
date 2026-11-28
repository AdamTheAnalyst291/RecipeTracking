#!/usr/bin/env bash
# Run after `terraform apply` in infra/bootstrap. Creates each GitHub Environment that
# doesn't exist yet and sets the variables the deploy workflows sign in with. Every
# value is an ID, not a secret: OIDC means no Azure key or password is stored in GitHub.
#
#   cd infra/bootstrap && ./configure-github.sh
#
# Needs: gh (signed in with admin rights on the repository), terraform, node.
set -euo pipefail

cd "$(dirname "$0")"
repo="${GITHUB_REPOSITORY:-AdamTheAnalyst291/RecipeTracking}"

out="$(terraform output -json)"
tf_output() { node -e 'const o=JSON.parse(process.argv[1]); console.log(process.argv[2].split(".").reduce((v,k)=>v[k],o).value ?? "")' "$out" "$1"; }

subscription_id="$(tf_output subscription_id)"
tenant_id="$(tf_output tenant_id)"

echo "Repository variables for Terraform state"
gh variable set TF_STATE_RESOURCE_GROUP --repo "$repo" --body "$(tf_output state_resource_group)"
gh variable set TF_STATE_STORAGE_ACCOUNT --repo "$repo" --body "$(tf_output state_storage_account)"

for env in $(node -e 'console.log(Object.keys(JSON.parse(process.argv[1]).deploy_identities.value).join(" "))' "$out"); do
  deploy_identity() { node -e 'console.log(JSON.parse(process.argv[1]).deploy_identities.value[process.argv[2]][process.argv[3]])' "$out" "$env" "$1"; }

  echo "GitHub Environment $env"
  # Create it only if it's missing, so a rerun never touches protection rules
  # (such as prod's required reviewer) set up by hand.
  if ! gh api "repos/$repo/environments/$env" --silent 2>/dev/null; then
    gh api --method PUT "repos/$repo/environments/$env" --silent
  fi
  gh variable set AZURE_CLIENT_ID --repo "$repo" --env "$env" --body "$(deploy_identity client_id)"
  gh variable set AZURE_PRINCIPAL_ID --repo "$repo" --env "$env" --body "$(deploy_identity principal_id)"
  gh variable set AZURE_TENANT_ID --repo "$repo" --env "$env" --body "$tenant_id"
  gh variable set AZURE_SUBSCRIPTION_ID --repo "$repo" --env "$env" --body "$subscription_id"
done

# The weekly export (card S2) runs in <env>-backup as its own identity. A scheduled job
# can't wait for a reviewer, so this environment has none; instead it allows main only,
# and its identity can only read the database and write the export container.
for env in $(node -e 'console.log(Object.keys(JSON.parse(process.argv[1]).backup_identities.value).join(" "))' "$out"); do
  backup_identity() { node -e 'console.log(JSON.parse(process.argv[1]).backup_identities.value[process.argv[2]][process.argv[3]])' "$out" "$env" "$1"; }

  echo "GitHub Environment $env-backup"
  if ! gh api "repos/$repo/environments/$env-backup" --silent 2>/dev/null; then
    gh api --method PUT "repos/$repo/environments/$env-backup" --silent \
      -F "deployment_branch_policy[protected_branches]=false" \
      -F "deployment_branch_policy[custom_branch_policies]=true"
    gh api --method POST "repos/$repo/environments/$env-backup/deployment-branch-policies" --silent \
      -f name=main -f type=branch
  fi
  gh variable set AZURE_CLIENT_ID --repo "$repo" --env "$env-backup" --body "$(backup_identity client_id)"
  gh variable set AZURE_TENANT_ID --repo "$repo" --env "$env-backup" --body "$tenant_id"
  gh variable set AZURE_SUBSCRIPTION_ID --repo "$repo" --env "$env-backup" --body "$subscription_id"

  # For the deploy: Terraform grants the export container to this principal, and the
  # migration step makes the client ID a read-only database user.
  gh variable set AZURE_BACKUP_PRINCIPAL_ID --repo "$repo" --env "$env" --body "$(backup_identity principal_id)"
  gh variable set AZURE_BACKUP_CLIENT_ID --repo "$repo" --env "$env" --body "$(backup_identity client_id)"
done

# The nightly warehouse build (card W1) runs in <env>-warehouse as its own identity, for the
# same reason: no reviewer, main only, and an identity that can only read the app's tables,
# build the marts schema and read the ntfy-topic secret.
for env in $(node -e 'console.log(Object.keys(JSON.parse(process.argv[1]).warehouse_identities.value).join(" "))' "$out"); do
  warehouse_identity() { node -e 'console.log(JSON.parse(process.argv[1]).warehouse_identities.value[process.argv[2]][process.argv[3]])' "$out" "$env" "$1"; }

  echo "GitHub Environment $env-warehouse"
  if ! gh api "repos/$repo/environments/$env-warehouse" --silent 2>/dev/null; then
    gh api --method PUT "repos/$repo/environments/$env-warehouse" --silent       -F "deployment_branch_policy[protected_branches]=false"       -F "deployment_branch_policy[custom_branch_policies]=true"
    gh api --method POST "repos/$repo/environments/$env-warehouse/deployment-branch-policies" --silent       -f name=main -f type=branch
  fi
  gh variable set AZURE_CLIENT_ID --repo "$repo" --env "$env-warehouse" --body "$(warehouse_identity client_id)"
  gh variable set AZURE_TENANT_ID --repo "$repo" --env "$env-warehouse" --body "$tenant_id"

  # For the deploy: Terraform lets this principal read the ntfy-topic secret, and the
  # migration step makes the client ID the database user that builds marts.
  gh variable set AZURE_WAREHOUSE_PRINCIPAL_ID --repo "$repo" --env "$env" --body "$(warehouse_identity principal_id)"
  gh variable set AZURE_WAREHOUSE_CLIENT_ID --repo "$repo" --env "$env" --body "$(warehouse_identity client_id)"
done

echo "Done."
