# Plan-only tests with mocked providers: no Azure sign-in, nothing created.
# They pin what makes this root Prod rather than another copy of Dev.
# Run with: terraform -chdir=infra/environments/prod init -backend=false
#           terraform -chdir=infra/environments/prod test

mock_provider "azurerm" {
  mock_data "azurerm_client_config" {
    defaults = {
      subscription_id = "00000000-0000-0000-0000-000000000001"
      tenant_id       = "00000000-0000-0000-0000-000000000002"
      object_id       = "00000000-0000-0000-0000-000000000003"
    }
  }

  mock_resource "azurerm_storage_account" {
    defaults = {
      primary_blob_endpoint = "https://stkitchenprodabc123.blob.core.windows.net/"
    }
  }
}

mock_provider "azapi" {}

variables {
  deploy_identity_object_id = "00000000-0000-0000-0000-000000000005"
}

run "prod_lives_in_its_own_resource_group_in_centralus" {
  command = plan

  assert {
    condition = alltrue([
      startswith(output.function_app_name, "func-kitchen-prod-"),
      startswith(output.key_vault_name, "kv-kitchen-prod-"),
      startswith(output.static_web_app_name, "swa-kitchen-prod-"),
      startswith(module.environment.sql_server_name, "sql-kitchen-prod-"),
    ])
    error_message = "Every Prod resource must be named for prod."
  }

  assert {
    condition     = module.environment.settings.resource_group_name == "rg-kitchen-prod"
    error_message = "Prod's resources must go in rg-kitchen-prod, the group the Prod deploy identity can manage."
  }

  assert {
    condition     = module.environment.settings.location == "centralus"
    error_message = "Prod must be in centralus: every free Azure SQL database in the subscription shares one region."
  }

  assert {
    condition     = module.environment.settings.database_uses_free_offer == true
    error_message = "Prod's own database must use the Azure SQL free offer."
  }
}

run "prod_database_is_administered_by_the_prod_deploy_identity" {
  command = plan

  assert {
    condition     = module.environment.settings.sql_admin_login == "kitchen-github-prod"
    error_message = "Prod's SQL admin must be the kitchen-github-prod deploy identity, never Dev's."
  }

  assert {
    condition     = module.environment.settings.sql_admin_object_id == var.deploy_identity_object_id
    error_message = "Prod's SQL admin must be the identity the pipeline signs in as."
  }
}

run "prod_key_vault_cannot_be_purged" {
  command = plan

  assert {
    condition     = module.environment.settings.key_vault_purge_protection
    error_message = "Prod's Key Vault holds the Plaid Production secret, so purge protection must be on."
  }
}

run "prod_api_does_not_accept_localhost" {
  command = plan

  assert {
    condition     = !contains(module.environment.settings.api_allowed_origins, "http://localhost:5173")
    error_message = "Prod's API must not accept calls from a local dev server."
  }
}

run "sign_in_stays_off_until_the_app_registration_exists" {
  command = plan

  assert {
    condition     = output.auth_client_id == ""
    error_message = "With no KITCHEN_AUTH_CLIENT_ID, Prod's client ID must be empty."
  }
}

run "takes_the_kitchen_prod_app_registration" {
  command = plan

  variables {
    auth_client_id = "00000000-0000-0000-0000-000000000004"
  }

  assert {
    condition     = output.auth_client_id == "00000000-0000-0000-0000-000000000004"
    error_message = "Prod must pass KITCHEN_AUTH_CLIENT_ID on to the API and web app."
  }
}

run "prod_exports_its_database_weekly" {
  command = plan

  assert {
    condition     = startswith(output.exports_storage_account_name, "stkitchenbakprod") && output.exports_container_name == "database-exports"
    error_message = "Prod must have the weekly export's storage (card S2)."
  }

  assert {
    condition     = length(module.environment.exports_backup_identity_principal_ids) == 0
    error_message = "With no AZURE_BACKUP_PRINCIPAL_ID yet, nobody may write the exports."
  }
}

run "the_backup_identity_may_write_prod_exports" {
  command = plan

  variables {
    backup_identity_object_id = "00000000-0000-0000-0000-000000000006"
  }

  assert {
    condition     = module.environment.exports_backup_identity_principal_ids == ["00000000-0000-0000-0000-000000000006"]
    error_message = "Prod must grant the export container to kitchen-github-prod-backup and nobody else."
  }

  assert {
    condition     = module.environment.exports_backup_identity_principal_ids != [var.deploy_identity_object_id]
    error_message = "The backup job must not run as the Prod deploy identity."
  }
}
