# Plan-only tests with mocked providers: no Azure sign-in, nothing created.
# They pin the choices that keep an environment on Azure's free services.
# Run with: terraform -chdir=infra/modules/environment test

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
      primary_blob_endpoint = "https://stkitchendevabc123.blob.core.windows.net/"
    }
  }
}

mock_provider "azapi" {
  mock_data "azapi_resource" {
    defaults = {
      output = { properties = { clientId = "00000000-0000-0000-0000-000000000007" } }
    }
  }
}

variables {
  environment         = "dev"
  resource_group_name = "rg-kitchen-dev"
  location            = "centralus"
  sql_admin = {
    login_username = "kitchen-github-dev"
    object_id      = "00000000-0000-0000-0000-000000000003"
  }
}

run "web_app_is_on_the_free_plan" {
  command = plan

  assert {
    condition     = azurerm_static_web_app.web.sku_tier == "Free" && azurerm_static_web_app.web.sku_size == "Free"
    error_message = "Static Web Apps must use the Free plan."
  }
}

run "api_is_a_flex_consumption_node_24_app_with_a_managed_identity" {
  command = plan

  assert {
    condition     = azurerm_service_plan.api.sku_name == "FC1" && azurerm_service_plan.api.os_type == "Linux"
    error_message = "The API must run on the Linux Flex Consumption plan (FC1)."
  }

  assert {
    condition     = azurerm_function_app_flex_consumption.api.runtime_name == "node" && azurerm_function_app_flex_consumption.api.runtime_version == "24"
    error_message = "The API must run on Node 24."
  }

  assert {
    condition     = azurerm_function_app_flex_consumption.api.identity[0].type == "SystemAssigned"
    error_message = "The API needs a system-assigned managed identity."
  }

  assert {
    condition     = azurerm_function_app_flex_consumption.api.storage_authentication_type == "SystemAssignedIdentity"
    error_message = "The API must reach its storage with its managed identity, not a key."
  }

  assert {
    condition     = length(azurerm_function_app_flex_consumption.api.always_ready) == 0
    error_message = "Always-ready instances are billed outside the free grant."
  }

  assert {
    condition     = contains(azapi_resource_action.api_cors.body.properties.cors.allowedOrigins, "http://localhost:5173")
    error_message = "Dev's API must accept calls from the local Vite server."
  }
}

run "api_can_read_key_vault_secrets" {
  command = plan

  assert {
    condition     = azurerm_role_assignment.api_key_vault.role_definition_name == "Key Vault Secrets User"
    error_message = "The API's identity must be able to read Key Vault secrets."
  }

  assert {
    condition     = contains(keys(azurerm_function_app_flex_consumption.api.app_settings), "KITCHEN_KEY_VAULT_URI")
    error_message = "The API must be told which Key Vault holds its secrets."
  }

  assert {
    condition     = azurerm_key_vault.this.rbac_authorization_enabled
    error_message = "Key Vault access must use Azure RBAC."
  }
}

run "plaid_access_tokens_go_to_a_vault_of_their_own" {
  command = plan

  # Give the two vaults known ids at plan time, so the role assignments' scopes can be compared.
  override_resource {
    target          = azurerm_key_vault.this
    override_during = plan
    values          = { id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-kitchen-dev/providers/Microsoft.KeyVault/vaults/main" }
  }
  override_resource {
    target          = azurerm_key_vault.tokens
    override_during = plan
    values          = { id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-kitchen-dev/providers/Microsoft.KeyVault/vaults/tokens" }
  }

  assert {
    condition     = azurerm_role_assignment.api_token_vault.role_definition_name == "Key Vault Secrets Officer" && azurerm_role_assignment.api_token_vault.scope == azurerm_key_vault.tokens.id
    error_message = "The API's identity must be able to write secrets in the token vault, to store Plaid access tokens."
  }

  assert {
    condition     = azurerm_role_assignment.api_key_vault.role_definition_name == "Key Vault Secrets User" && azurerm_role_assignment.api_key_vault.scope == azurerm_key_vault.this.id
    error_message = "The API's identity must only read the main vault: write access there could change household-members."
  }

  assert {
    condition     = azurerm_key_vault.tokens.rbac_authorization_enabled && azurerm_key_vault.tokens.name != azurerm_key_vault.this.name
    error_message = "The token vault must be a separate vault using Azure RBAC."
  }

  assert {
    condition     = length(azurerm_key_vault.tokens.name) <= 24 && length("kv-kitchen-prod-${substr(sha1("x"), 0, 6)}-t") <= 24
    error_message = "Key Vault names can be at most 24 characters, in every environment."
  }

  assert {
    condition     = azurerm_key_vault.tokens.purge_protection_enabled == azurerm_key_vault.this.purge_protection_enabled
    error_message = "The token vault's purge protection must follow the main vault's."
  }

  assert {
    condition     = azurerm_function_app_flex_consumption.api.app_settings["KITCHEN_TOKEN_VAULT_NAME"] == azurerm_key_vault.tokens.name
    error_message = "The API must be told which vault takes the access tokens."
  }
}

run "bank_sync_settings_come_from_the_main_vault" {
  command = plan

  assert {
    condition     = azurerm_function_app_flex_consumption.api.app_settings["PLAID_ENV"] == "sandbox"
    error_message = "Plaid defaults to Sandbox."
  }

  assert {
    condition = alltrue([
      for name, secret in { PLAID_CLIENT_ID = "plaid-client-id", PLAID_SECRET = "plaid-secret", KITCHEN_ALERT_NTFY_TOPIC = "ntfy-topic" } :
      azurerm_function_app_flex_consumption.api.app_settings[name] == "@Microsoft.KeyVault(VaultName=${azurerm_key_vault.this.name};SecretName=${secret})"
    ])
    error_message = "The Plaid keys and the ntfy topic must be Key Vault references to the main vault, never values."
  }
}

run "plaid_environment_must_be_sandbox_or_production" {
  command = plan

  variables {
    plaid_environment = "development"
  }

  expect_failures = [var.plaid_environment]
}

# The Banks 503 (card $2): without these two settings getPool() refuses before it opens a
# connection, so every database screen answers 503.
run "api_is_told_which_database_to_use" {
  command = plan

  override_resource {
    target          = azurerm_mssql_server.this
    override_during = plan
    values = {
      id                          = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-kitchen-dev/providers/Microsoft.Sql/servers/sql-kitchen-dev-abc123"
      fully_qualified_domain_name = "sql-kitchen-dev-abc123.database.windows.net"
    }
  }

  assert {
    condition     = azurerm_function_app_flex_consumption.api.app_settings["SQL_SERVER"] == "sql-kitchen-dev-abc123.database.windows.net"
    error_message = "The API must be told the SQL server's full name (SQL_SERVER)."
  }

  assert {
    condition     = azurerm_function_app_flex_consumption.api.app_settings["SQL_DATABASE"] == "sqldb-kitchen-app"
    error_message = "The API must be told the app database's name (SQL_DATABASE)."
  }
}

# The migration step creates the API's database user from this client ID (function_app_client_id).
# A data source that reads a resource being created is only read during apply, so the plan
# can check where the value comes from, not the value.
run "the_api_identity_client_id_comes_from_its_own_identity" {
  command = plan

  assert {
    condition     = data.azapi_resource.api_identity.type == "Microsoft.ManagedIdentity/identities@2023-01-31" && data.azapi_resource.api_identity.name == "default"
    error_message = "The client ID comes from the API's system-assigned identity (identities/default)."
  }

  assert {
    condition     = contains(data.azapi_resource.api_identity.response_export_values, "properties.clientId")
    error_message = "The client ID must be read from the identity."
  }
}

run "api_logs_go_to_application_insights_with_a_small_daily_cap" {
  command = plan

  override_resource {
    target          = azurerm_application_insights.api
    override_during = plan
    values          = { connection_string = "InstrumentationKey=00000000-0000-0000-0000-000000000008" }
  }
  override_resource {
    target          = azurerm_log_analytics_workspace.this
    override_during = plan
    values          = { id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-kitchen-dev/providers/Microsoft.OperationalInsights/workspaces/log" }
  }

  assert {
    condition     = azurerm_application_insights.api.workspace_id == azurerm_log_analytics_workspace.this.id
    error_message = "Application Insights must be workspace-based, on this environment's workspace."
  }

  assert {
    condition     = azurerm_log_analytics_workspace.this.sku == "PerGB2018" && azurerm_log_analytics_workspace.this.retention_in_days == 30
    error_message = "The workspace must be pay-as-you-go with the 30 days of retention that are free."
  }

  assert {
    condition     = azurerm_log_analytics_workspace.this.daily_quota_gb > 0 && azurerm_log_analytics_workspace.this.daily_quota_gb <= 0.08
    error_message = "The workspace needs a daily cap that keeps Dev and Prod together under the 5 GB a month that's free."
  }

  assert {
    condition     = azurerm_application_insights.api.application_type == "Node.JS" && azurerm_application_insights.api.daily_data_cap_in_gb <= 0.08
    error_message = "Application Insights must be the Node.js kind, with the same small daily cap."
  }

  assert {
    condition     = azurerm_application_insights.api.retention_in_days == 30
    error_message = "Application Insights keeps the free 30 days only."
  }

  assert {
    condition     = azurerm_function_app_flex_consumption.api.site_config[0].application_insights_connection_string == "InstrumentationKey=00000000-0000-0000-0000-000000000008"
    error_message = "The API must send its logs to this environment's Application Insights."
  }
}

run "app_database_uses_the_free_offer_and_pauses_instead_of_billing" {
  command = plan

  assert {
    condition     = azapi_resource.app_database.body.properties.useFreeLimit == true
    error_message = "The app database must use the Azure SQL free offer."
  }

  assert {
    condition     = azapi_resource.app_database.body.properties.freeLimitExhaustionBehavior == "AutoPause"
    error_message = "The app database must pause, not bill, when the free allowance runs out."
  }
}

run "sql_server_accepts_entra_sign_in_and_azure_services_only" {
  command = plan

  assert {
    condition     = azurerm_mssql_server.this.azuread_administrator[0].azuread_authentication_only
    error_message = "The SQL server must accept Microsoft Entra sign-in only."
  }

  assert {
    condition     = azurerm_mssql_server.this.azuread_administrator[0].object_id == var.sql_admin.object_id
    error_message = "The SQL server's Entra admin must be the environment's deploy identity."
  }

  assert {
    condition     = azurerm_mssql_firewall_rule.azure_services.start_ip_address == "0.0.0.0" && azurerm_mssql_firewall_rule.azure_services.end_ip_address == "0.0.0.0"
    error_message = "The only firewall rule must be Azure's allow-Azure-services rule."
  }
}

run "non_dev_api_does_not_accept_localhost" {
  command = plan

  variables {
    environment = "prod"
  }

  assert {
    condition     = !contains(azapi_resource_action.api_cors.body.properties.cors.allowedOrigins, "http://localhost:5173")
    error_message = "Only Dev may accept calls from localhost."
  }
}

run "rejects_unknown_environment_names" {
  command = plan

  variables {
    environment = "staging"
  }

  expect_failures = [var.environment]
}

# Azure keeps a deleted or failed resource's name tied to its old region for a while,
# so moving an environment to another region must give it fresh names.
run "names_in_centralus" {
  command = plan

  variables {
    location = "centralus"
  }
}

run "names_change_with_location" {
  command = plan

  variables {
    location = "westus3"
  }

  assert {
    condition = alltrue([
      output.key_vault_name != run.names_in_centralus.key_vault_name,
      output.sql_server_name != run.names_in_centralus.sql_server_name,
      output.function_app_name != run.names_in_centralus.function_app_name,
      output.static_web_app_name != run.names_in_centralus.static_web_app_name,
    ])
    error_message = "Globally unique names must change when the location changes."
  }
}

run "api_checks_sign_in_against_the_app_registration_and_a_key_vault_household" {
  command = plan

  variables {
    auth_client_id = "00000000-0000-0000-0000-000000000004"
  }

  assert {
    condition     = azurerm_function_app_flex_consumption.api.app_settings["KITCHEN_AUTH_TENANT_ID"] == "00000000-0000-0000-0000-000000000002"
    error_message = "The API must trust tokens from the subscription's own tenant."
  }

  assert {
    condition     = azurerm_function_app_flex_consumption.api.app_settings["KITCHEN_AUTH_CLIENT_ID"] == "00000000-0000-0000-0000-000000000004"
    error_message = "The API must accept tokens for the environment's app registration only."
  }

  assert {
    condition     = azurerm_function_app_flex_consumption.api.app_settings["KITCHEN_HOUSEHOLD_MEMBERS"] == "@Microsoft.KeyVault(VaultName=${azurerm_key_vault.this.name};SecretName=household-members)"
    error_message = "Household members must come from Key Vault, never from Terraform or git."
  }
}

run "rejects_a_client_id_that_is_not_a_guid" {
  command = plan

  variables {
    auth_client_id = "kitchen-dev"
  }

  expect_failures = [var.auth_client_id]
}

# --- Database exports (card S2) ----------------------------------------------

run "no_export_storage_unless_asked_for" {
  command = plan

  assert {
    condition     = length(azurerm_storage_account.exports) == 0 && length(azurerm_storage_container.exports) == 0
    error_message = "Only an environment that turns on database_exports gets export storage."
  }
}

run "exports_go_to_a_versioned_soft_deleted_container_with_no_account_keys" {
  command = plan

  variables {
    environment      = "prod"
    database_exports = true
  }

  assert {
    condition     = startswith(azurerm_storage_account.exports[0].name, "stkitchenbakprod") && length(azurerm_storage_account.exports[0].name) <= 24
    error_message = "The export account must be named stkitchenbak<env><suffix>, at most 24 characters."
  }

  assert {
    condition     = azurerm_storage_account.exports[0].shared_access_key_enabled == false && azurerm_storage_account.exports[0].allow_nested_items_to_be_public == false
    error_message = "Exports must be reached with Entra ID only: no account keys, nothing public."
  }

  assert {
    condition     = azurerm_storage_account.exports[0].blob_properties[0].versioning_enabled
    error_message = "Blob versioning must be on, so an overwritten or deleted export keeps a version."
  }

  assert {
    condition     = azurerm_storage_account.exports[0].blob_properties[0].delete_retention_policy[0].days >= 14
    error_message = "Deleted exports must stay soft-deleted for at least 14 days."
  }

  assert {
    condition     = azurerm_storage_account.exports[0].blob_properties[0].container_delete_retention_policy[0].days >= 14
    error_message = "A deleted export container must stay soft-deleted for at least 14 days."
  }

  assert {
    condition     = azurerm_storage_container.exports[0].name == "database-exports" && azurerm_storage_container.exports[0].container_access_type == "private"
    error_message = "Exports go in the private container database-exports."
  }

  assert {
    condition     = one(one(azurerm_storage_management_policy.exports[0].rule).actions[0].version).delete_after_days_since_creation >= 30
    error_message = "Old versions of exports must be kept at least 30 days before they're cleaned up."
  }
}

run "backup_reader_may_write_exports_and_nothing_else" {
  command = plan

  variables {
    environment               = "prod"
    database_exports          = true
    backup_identity_object_id = "00000000-0000-0000-0000-000000000006"
  }

  assert {
    condition     = length(azurerm_role_assignment.exports_backup_identity) == 1
    error_message = "The backup identity needs exactly one role assignment."
  }

  assert {
    condition     = azurerm_role_assignment.exports_backup_identity[0].role_definition_name == "Storage Blob Data Contributor"
    error_message = "The backup identity gets Storage Blob Data Contributor, which can't delete blob versions, never Owner."
  }

  assert {
    condition     = azurerm_role_assignment.exports_backup_identity[0].principal_id == "00000000-0000-0000-0000-000000000006" && azurerm_role_assignment.exports_backup_identity[0].principal_type == "ServicePrincipal"
    error_message = "The role must go to the backup identity's service principal."
  }
}

run "no_role_assignment_until_the_backup_identity_exists" {
  command = plan

  variables {
    environment      = "prod"
    database_exports = true
  }

  assert {
    condition     = length(azurerm_role_assignment.exports_backup_identity) == 0
    error_message = "With no backup identity, nobody is granted access to the exports."
  }
}

run "grants_nothing_while_exports_are_off" {
  command = plan

  variables {
    backup_identity_object_id = "00000000-0000-0000-0000-000000000006"
  }

  assert {
    condition     = length(azurerm_role_assignment.exports_backup_identity) == 0
    error_message = "Without database_exports there is no container to grant."
  }
}

run "rejects_a_backup_identity_that_is_not_a_guid" {
  command = plan

  variables {
    backup_identity_object_id = "kitchen-github-prod-backup"
  }

  expect_failures = [var.backup_identity_object_id]
}

# --- Warehouse identity (card W1) ------------------------------------------------

run "warehouse_identity_may_read_the_ntfy_topic_and_no_other_secret" {
  command = plan

  variables {
    warehouse_identity_object_id = "00000000-0000-0000-0000-000000000008"
  }

  # The vault's ID is only known after apply; give it one so the scope can be checked.
  override_resource {
    target          = azurerm_key_vault.this
    override_during = plan
    values = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-kitchen-dev/providers/Microsoft.KeyVault/vaults/kv-kitchen-dev-abc123"
    }
  }

  assert {
    condition     = length(azurerm_role_assignment.warehouse_alert_topic) == 1
    error_message = "The warehouse identity needs to read the ntfy topic for its failure alert."
  }

  assert {
    condition     = azurerm_role_assignment.warehouse_alert_topic[0].scope == "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-kitchen-dev/providers/Microsoft.KeyVault/vaults/kv-kitchen-dev-abc123/secrets/ntfy-topic"
    error_message = "The warehouse identity may read the ntfy-topic secret only, never the whole vault (it holds the Plaid keys)."
  }

  assert {
    condition     = azurerm_role_assignment.warehouse_alert_topic[0].role_definition_name == "Key Vault Secrets User"
    error_message = "Reading the topic needs Key Vault Secrets User and nothing more."
  }

  assert {
    condition     = azurerm_role_assignment.warehouse_alert_topic[0].principal_id == "00000000-0000-0000-0000-000000000008" && azurerm_role_assignment.warehouse_alert_topic[0].principal_type == "ServicePrincipal"
    error_message = "The role goes to the warehouse identity's service principal."
  }

  assert {
    condition     = output.warehouse_alert_topic_reader_ids == ["00000000-0000-0000-0000-000000000008"]
    error_message = "The output lists who may read the alert topic."
  }
}

run "no_warehouse_role_until_the_warehouse_identity_exists" {
  command = plan

  assert {
    condition     = length(azurerm_role_assignment.warehouse_alert_topic) == 0
    error_message = "Nothing is granted while warehouse_identity_object_id is empty."
  }
}

run "rejects_a_warehouse_identity_that_is_not_a_guid" {
  command = plan

  variables {
    warehouse_identity_object_id = "kitchen-github-dev-warehouse"
  }

  expect_failures = [var.warehouse_identity_object_id]
}
