# Plan-only tests with mocked providers: no Azure sign-in, nothing created.
# They pin what the bootstrap promises: the kitchen's names and region, deploy
# identities that trust only this repository's GitHub Environments, and a budget
# that counts only the kitchen's resource groups.
# Run with: terraform -chdir=infra/bootstrap test

mock_provider "azurerm" {}
mock_provider "azuread" {}

variables {
  subscription_id      = "00000000-0000-0000-0000-000000000001"
  tenant_id            = "00000000-0000-0000-0000-000000000002"
  budget_contact_email = "alerts@example.com"
}

run "dev_and_prod_get_kitchen_resource_groups_in_centralus" {
  command = plan

  assert {
    condition     = toset(keys(azurerm_resource_group.environment)) == toset(["dev", "prod"])
    error_message = "The bootstrap must set up dev and prod by default."
  }

  assert {
    condition     = azurerm_resource_group.environment["dev"].name == "rg-kitchen-dev" && azurerm_resource_group.environment["prod"].name == "rg-kitchen-prod"
    error_message = "Environment resource groups must be named rg-kitchen-<env>."
  }

  assert {
    condition     = alltrue([for g in azurerm_resource_group.environment : g.location == "centralus"])
    error_message = "Environment resource groups must be in centralus."
  }
}

run "state_has_one_container_per_environment_and_no_account_keys" {
  command = plan

  assert {
    condition     = azurerm_resource_group.state.name == "rg-kitchen-tfstate"
    error_message = "The state resource group must be rg-kitchen-tfstate."
  }

  assert {
    condition     = azurerm_resource_group.state.location == "centralus" && azurerm_storage_account.state.location == "centralus"
    error_message = "State lives in centralus with the rest of the kitchen."
  }

  assert {
    condition     = startswith(azurerm_storage_account.state.name, "stkitchentf") && length(azurerm_storage_account.state.name) <= 24
    error_message = "The state account must be stkitchentf<suffix> and fit Azure's 24-character limit."
  }

  assert {
    condition     = azurerm_storage_account.state.shared_access_key_enabled == false
    error_message = "State must be reached with Entra ID only, never an account key."
  }

  assert {
    condition     = toset([for c in azurerm_storage_container.state : c.name]) == toset(["tfstate-dev", "tfstate-prod"])
    error_message = "Each environment needs its own tfstate-<env> container."
  }
}

run "deploy_identities_trust_only_this_repos_github_environment" {
  command = plan

  assert {
    condition     = azuread_application.deploy["dev"].display_name == "kitchen-github-dev" && azuread_application.deploy["prod"].display_name == "kitchen-github-prod"
    error_message = "Deploy identities must be named kitchen-github-<env>."
  }

  assert {
    condition     = azuread_application_federated_identity_credential.github_environment["dev"].subject == "repo:AdamTheAnalyst291@225034465/RecipeTracking@1433625977:environment:dev"
    error_message = "The dev identity must trust only the dev GitHub Environment of this repository, by immutable IDs."
  }

  assert {
    condition     = azuread_application_federated_identity_credential.github_environment["prod"].subject == "repo:AdamTheAnalyst291@225034465/RecipeTracking@1433625977:environment:prod"
    error_message = "The prod identity must trust only the prod GitHub Environment of this repository, by immutable IDs."
  }

  assert {
    condition     = alltrue([for c in azuread_application_federated_identity_credential.github_environment : c.issuer == "https://token.actions.githubusercontent.com" && c.audiences == tolist(["api://AzureADTokenExchange"])])
    error_message = "Federated credentials must accept only GitHub Actions tokens meant for Azure."
  }
}

run "deploy_identities_get_contributor_only_on_their_own_group" {
  command = plan

  assert {
    condition     = alltrue([for e, a in azurerm_role_assignment.deploy_contributor : a.role_definition_name == "Contributor"])
    error_message = "Each deploy identity is Contributor on its resource group."
  }

  assert {
    condition     = alltrue([for e, a in azurerm_role_assignment.deploy_role_assignments : a.role_definition_name == "Role Based Access Control Administrator" && a.condition != null])
    error_message = "Role assignment rights must be limited by a condition."
  }

  assert {
    condition     = alltrue([for e, a in azurerm_role_assignment.deploy_state : a.role_definition_name == "Storage Blob Data Contributor"])
    error_message = "Each deploy identity may write only its own state container."
  }
}

run "kitchen_budget_is_10_a_month_and_counts_only_kitchen_groups" {
  command = plan

  assert {
    condition     = azurerm_consumption_budget_subscription.kitchen.name == "kitchen-monthly" && azurerm_consumption_budget_subscription.kitchen.amount == 10
    error_message = "The kitchen budget is kitchen-monthly, $10 a month."
  }

  assert {
    condition     = one(azurerm_consumption_budget_subscription.kitchen.filter[0].dimension).name == "ResourceGroupName"
    error_message = "The kitchen budget must be filtered by resource group, not count the whole subscription."
  }

  assert {
    condition     = toset(one(azurerm_consumption_budget_subscription.kitchen.filter[0].dimension).values) == toset(["rg-kitchen-tfstate", "rg-kitchen-dev", "rg-kitchen-prod"])
    error_message = "The kitchen budget must count the kitchen's resource groups and nothing else."
  }

  assert {
    condition     = toset([for n in azurerm_consumption_budget_subscription.kitchen.notification : "${n.threshold_type}:${n.threshold}"]) == toset(["Actual:50", "Actual:100", "Forecasted:100"])
    error_message = "Alerts go out at 50% and 100% of actual spend and 100% of forecast."
  }
}

run "only_dev_uat_and_prod_are_allowed" {
  command = plan

  variables {
    environments = ["dev", "staging"]
  }

  expect_failures = [var.environments]
}

# --- Backup identity (card S2) -------------------------------------------------

run "prod_gets_a_backup_identity_that_trusts_only_the_prod_backup_environment" {
  command = plan

  assert {
    condition     = toset(keys(azuread_application.backup)) == toset(["prod"])
    error_message = "Only Prod has a backup identity."
  }

  assert {
    condition     = azuread_application.backup["prod"].display_name == "kitchen-github-prod-backup"
    error_message = "The backup identity must be named kitchen-github-prod-backup."
  }

  assert {
    condition     = azuread_application_federated_identity_credential.backup_environment["prod"].subject == "repo:AdamTheAnalyst291@225034465/RecipeTracking@1433625977:environment:prod-backup"
    error_message = "The backup identity must trust the prod-backup GitHub Environment only, never prod itself."
  }

  assert {
    condition     = azuread_application_federated_identity_credential.backup_environment["prod"].issuer == "https://token.actions.githubusercontent.com" && azuread_application_federated_identity_credential.backup_environment["prod"].audiences == tolist(["api://AzureADTokenExchange"])
    error_message = "The backup identity's credential must be GitHub's OIDC issuer and audience."
  }
}

run "deploy_identities_may_grant_storage_blob_data_contributor_for_the_exports" {
  command = plan

  assert {
    condition     = strcontains(azurerm_role_assignment.deploy_role_assignments["prod"].condition, "ba92f5b4-2d11-453d-a403-e96b0029c9fe")
    error_message = "Prod's deploy identity must be able to grant Storage Blob Data Contributor (the backup identity's role on the export container)."
  }

  assert {
    condition     = !strcontains(azurerm_role_assignment.deploy_role_assignments["prod"].condition, "8e3af657-a8ff-443c-a75c-2fe8c4bcb635")
    error_message = "The deploy identity must never be able to grant Owner."
  }
}

run "deploy_identities_may_grant_key_vault_secrets_officer_for_the_token_vault" {
  command = plan

  assert {
    condition     = alltrue([for e in ["dev", "prod"] : strcontains(azurerm_role_assignment.deploy_role_assignments[e].condition, "b86a8fe4-44ce-4948-aee5-eccb2c155cd7")])
    error_message = "Each deploy identity must be able to grant Key Vault Secrets Officer (the API's role on the token-only vault, card $2)."
  }

  assert {
    condition     = alltrue([for e in ["dev", "prod"] : !strcontains(azurerm_role_assignment.deploy_role_assignments[e].condition, "18d7d88d-d35e-4fb5-a5c3-7773c20a72d9")])
    error_message = "The deploy identity must never be able to grant User Access Administrator."
  }
}

run "no_backup_identity_without_prod" {
  command = plan

  variables {
    environments = ["dev"]
  }

  assert {
    condition     = length(azuread_application.backup) == 0
    error_message = "Without Prod there is nothing to back up."
  }
}
