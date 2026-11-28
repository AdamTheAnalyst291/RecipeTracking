# One kitchen environment (Dev, UAT or Prod): web app, API, Key Vault and app database.
# Copied from Setlist's infra/modules/environment and adapted (ADR-25).
# The resource group, the GitHub deploy identity and its role assignments come from
# infra/bootstrap, so this module needs only rights on its own resource group.

data "azurerm_client_config" "current" {}

locals {
  # Globally unique names need a suffix. Deriving it from the subscription, environment
  # and location keeps it stable across runs without storing a random value. The
  # location is included because Azure keeps a deleted or failed resource's name tied
  # to its old region for a while, so a move to another region needs fresh names.
  suffix = substr(sha1("${data.azurerm_client_config.current.subscription_id}-${var.environment}-${var.location}"), 0, 6)

  tags = {
    app         = "kitchen"
    environment = var.environment
    managed_by  = "terraform"
  }

  # Key Vault secret holding the household members' Entra object IDs, comma-separated.
  household_members_secret = "household-members"

  # Vite's dev server, so the web app can call the Dev API from a laptop.
  local_origins = var.environment == "dev" ? ["http://localhost:5173"] : []
}

# --- Web app -----------------------------------------------------------------

resource "azurerm_static_web_app" "web" {
  name                = "swa-kitchen-${var.environment}-${local.suffix}"
  resource_group_name = var.resource_group_name
  location            = var.location
  sku_tier            = "Free"
  sku_size            = "Free"
  tags                = local.tags
}

# --- API ---------------------------------------------------------------------

# Flex Consumption keeps its deployment package and host state in this account.
resource "azurerm_storage_account" "functions" {
  name                            = "stkitchen${var.environment}${local.suffix}"
  resource_group_name             = var.resource_group_name
  location                        = var.location
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  min_tls_version                 = "TLS1_2"
  allow_nested_items_to_be_public = false
  tags                            = local.tags
}

resource "azurerm_storage_container" "deployments" {
  name                  = "deployments"
  storage_account_id    = azurerm_storage_account.functions.id
  container_access_type = "private"
}

resource "azurerm_service_plan" "api" {
  name                = "asp-kitchen-${var.environment}"
  resource_group_name = var.resource_group_name
  location            = var.location
  os_type             = "Linux"
  sku_name            = "FC1"
  tags                = local.tags
}

resource "azurerm_function_app_flex_consumption" "api" {
  name                = "func-kitchen-${var.environment}-${local.suffix}"
  resource_group_name = var.resource_group_name
  location            = var.location
  service_plan_id     = azurerm_service_plan.api.id

  runtime_name           = "node"
  runtime_version        = "24"
  instance_memory_in_mb  = 2048
  maximum_instance_count = var.function_maximum_instance_count

  # The app reads its deployment package and host storage with its own identity,
  # so no storage key is kept in its settings.
  storage_container_type      = "blobContainer"
  storage_container_endpoint  = "${azurerm_storage_account.functions.primary_blob_endpoint}${azurerm_storage_container.deployments.name}"
  storage_authentication_type = "SystemAssignedIdentity"

  https_only = true
  # Deploys sign in with Entra ID (OIDC), never with publishing passwords.
  webdeploy_publish_basic_authentication_enabled = false

  identity {
    type = "SystemAssigned"
  }

  app_settings = {
    AzureWebJobsStorage__accountName = azurerm_storage_account.functions.name
    KITCHEN_ENVIRONMENT              = var.environment
    # Where the API reads its secrets (Plaid and others), with its managed identity.
    KITCHEN_KEY_VAULT_URI = azurerm_key_vault.this.vault_uri

    # Sign-in (card F4). The API accepts Entra access tokens for the kitchen's app
    # registration and lets in only the household's members. Their object IDs stay out
    # of git and of the public Actions logs: they are a Key Vault secret you add by hand.
    KITCHEN_AUTH_TENANT_ID    = data.azurerm_client_config.current.tenant_id
    KITCHEN_AUTH_CLIENT_ID    = var.auth_client_id
    KITCHEN_HOUSEHOLD_MEMBERS = "@Microsoft.KeyVault(VaultName=${azurerm_key_vault.this.name};SecretName=${local.household_members_secret})"

    # Bank sync through Plaid (card $2, ADR-27). Sandbox in Dev, Production in Prod; the keys
    # and the ntfy alert topic are secrets you add by hand to the main vault (infra/README.md).
    PLAID_ENV                = var.plaid_environment
    PLAID_CLIENT_ID          = "@Microsoft.KeyVault(VaultName=${azurerm_key_vault.this.name};SecretName=plaid-client-id)"
    PLAID_SECRET             = "@Microsoft.KeyVault(VaultName=${azurerm_key_vault.this.name};SecretName=plaid-secret)"
    KITCHEN_ALERT_NTFY_TOPIC = "@Microsoft.KeyVault(VaultName=${azurerm_key_vault.this.name};SecretName=ntfy-topic)"
    # Where the API writes each bank connection's Plaid access token (see the token vault below).
    KITCHEN_TOKEN_VAULT_NAME = azurerm_key_vault.tokens.name

    # The app database, which the API signs in to with its managed identity (no password).
    # The migration step makes that identity a database user (packages/db, apiUser.ts).
    SQL_SERVER   = azurerm_mssql_server.this.fully_qualified_domain_name
    SQL_DATABASE = azapi_resource.app_database.name
  }

  site_config {
    minimum_tls_version = "1.2"
    # Sends the Functions logs (context.log and context.error) and request traces here.
    # The connection string names the resource and its ingestion key, which only lets
    # someone send telemetry, not read it; Microsoft doesn't treat it as a secret.
    application_insights_connection_string = azurerm_application_insights.api.connection_string
  }

  tags = local.tags

  lifecycle {
    # CORS is set by azapi_resource_action.api_cors below.
    ignore_changes = [site_config[0].cors]
  }
}

# Static Web Apps Free can't link its own Functions app, so the web app calls the
# API's own hostname directly and the API allows that origin. This is a separate
# PATCH because azurerm fails a first apply when the CORS origins aren't known
# until the web app exists ("site_config[0].cors: block count changed from 0 to 1").
resource "azapi_resource_action" "api_cors" {
  type        = "Microsoft.Web/sites/config@2023-12-01"
  resource_id = "${azurerm_function_app_flex_consumption.api.id}/config/web"
  method      = "PATCH"

  body = {
    properties = {
      cors = {
        allowedOrigins     = concat(["https://${azurerm_static_web_app.web.default_host_name}"], local.local_origins)
        supportCredentials = false
      }
    }
  }
}

# The client (application) ID of the API's system-assigned identity. azurerm only exposes
# its object ID, but a database user created by SID needs the client ID (the migration step,
# packages/db/src/apiUser.ts). Reading it needs no Microsoft Graph permission.
data "azapi_resource" "api_identity" {
  type                   = "Microsoft.ManagedIdentity/identities@2023-01-31"
  name                   = "default"
  parent_id              = azurerm_function_app_flex_consumption.api.id
  response_export_values = ["properties.clientId"]
}

# --- Logs --------------------------------------------------------------------

# Where the API's logs go. Pay-as-you-go: the first 5 GB a month are free across the
# billing account, so Dev and Prod share it. The daily caps (0.05 GB, about 1.5 GB a month
# per environment, 3 GB for both) stop ingestion before that runs out. 30 days of
# retention is included at no charge.
resource "azurerm_log_analytics_workspace" "this" {
  name                = "log-kitchen-${var.environment}-${local.suffix}"
  resource_group_name = var.resource_group_name
  location            = var.location
  sku                 = "PerGB2018"
  retention_in_days   = 30
  daily_quota_gb      = 0.05
  tags                = local.tags
}

resource "azurerm_application_insights" "api" {
  name                 = "appi-kitchen-${var.environment}-${local.suffix}"
  resource_group_name  = var.resource_group_name
  location             = var.location
  workspace_id         = azurerm_log_analytics_workspace.this.id
  application_type     = "Node.JS"
  retention_in_days    = 30
  daily_data_cap_in_gb = 0.05
  tags                 = local.tags
}

resource "azurerm_role_assignment" "api_storage" {
  scope                = azurerm_storage_account.functions.id
  role_definition_name = "Storage Blob Data Owner"
  principal_id         = azurerm_function_app_flex_consumption.api.identity[0].principal_id
  principal_type       = "ServicePrincipal"
}

# --- Secrets -----------------------------------------------------------------

# Holds the app's secrets, such as the Plaid keys (infra/README.md lists them).
# Terraform never sees their values: they are added by hand.
resource "azurerm_key_vault" "this" {
  name                       = "kv-kitchen-${var.environment}-${local.suffix}"
  resource_group_name        = var.resource_group_name
  location                   = var.location
  tenant_id                  = data.azurerm_client_config.current.tenant_id
  sku_name                   = "standard"
  rbac_authorization_enabled = true
  soft_delete_retention_days = 7
  purge_protection_enabled   = var.key_vault_purge_protection
  tags                       = local.tags
}

resource "azurerm_role_assignment" "api_key_vault" {
  scope                = azurerm_key_vault.this.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_function_app_flex_consumption.api.identity[0].principal_id
  principal_type       = "ServicePrincipal"
}

# The warehouse identity (kitchen-github-<env>-warehouse, card W1) reads the ntfy topic when
# the nightly dbt build fails, and no other secret: the role is scoped to that one secret,
# not the vault, which also holds the Plaid keys and household-members. Its database access
# comes from the migration step instead (packages/db/sql/warehouse-builder.sql).
resource "azurerm_role_assignment" "warehouse_alert_topic" {
  count = var.warehouse_identity_object_id != "" ? 1 : 0

  scope                = "${azurerm_key_vault.this.id}/secrets/ntfy-topic"
  role_definition_name = "Key Vault Secrets User"
  principal_id         = var.warehouse_identity_object_id
  principal_type       = "ServicePrincipal"
}

# Holds only the Plaid access tokens the API writes when a bank is connected (card $2). It is
# a vault of its own so the API's write access can't reach the main vault: a bug or a
# compromise that could write there could change household-members and let anyone in.
# "-t" keeps the name within Key Vault's 24 characters (kv-kitchen-prod-abc123-t is 24).
resource "azurerm_key_vault" "tokens" {
  name                       = "kv-kitchen-${var.environment}-${local.suffix}-t"
  resource_group_name        = var.resource_group_name
  location                   = var.location
  tenant_id                  = data.azurerm_client_config.current.tenant_id
  sku_name                   = "standard"
  rbac_authorization_enabled = true
  purge_protection_enabled   = var.key_vault_purge_protection
  tags                       = local.tags
}

resource "azurerm_role_assignment" "api_token_vault" {
  scope                = azurerm_key_vault.tokens.id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = azurerm_function_app_flex_consumption.api.identity[0].principal_id
  principal_type       = "ServicePrincipal"
}

# --- App database ------------------------------------------------------------

resource "azurerm_mssql_server" "this" {
  name                = "sql-kitchen-${var.environment}-${local.suffix}"
  resource_group_name = var.resource_group_name
  location            = var.location
  version             = "12.0"
  minimum_tls_version = "1.2"
  tags                = local.tags

  # Entra ID sign-in only, so no SQL password exists. The API signs in with its
  # managed identity once a migration creates its database user.
  azuread_administrator {
    login_username              = var.sql_admin.login_username
    object_id                   = var.sql_admin.object_id
    tenant_id                   = data.azurerm_client_config.current.tenant_id
    azuread_authentication_only = true
  }
}

# 0.0.0.0 is Azure's special rule for "allow Azure services". Nothing else is let in;
# add your own IP by hand when you need direct access, and remove it afterwards.
resource "azurerm_mssql_firewall_rule" "azure_services" {
  name             = "AllowAzureServices"
  server_id        = azurerm_mssql_server.this.id
  start_ip_address = "0.0.0.0"
  end_ip_address   = "0.0.0.0"
}

# azurerm has no setting for the free offer, so the database is created through the
# ARM API directly. The free-limit behaviour is fixed at creation: AutoPause pauses
# the database for the rest of the month instead of billing.
resource "azapi_resource" "app_database" {
  type      = "Microsoft.Sql/servers/databases@2023-08-01"
  name      = "sqldb-kitchen-app"
  parent_id = azurerm_mssql_server.this.id
  location  = var.location
  tags      = local.tags

  body = {
    sku = {
      name     = "GP_S_Gen5"
      tier     = "GeneralPurpose"
      family   = "Gen5"
      capacity = 2
    }
    properties = {
      useFreeLimit                     = true
      freeLimitExhaustionBehavior      = "AutoPause"
      maxSizeBytes                     = 34359738368 # 32 GB, the free limit
      autoPauseDelay                   = 60
      minCapacity                      = 0.5
      requestedBackupStorageRedundancy = "Local"
      zoneRedundant                    = false
    }
  }
}

# --- Database exports (card S2) ------------------------------------------------
# Point-in-time restore is the first line of defence (7 days on the free offer), but
# those backups go when the server does. A weekly export (.github/workflows/backup-prod.yml)
# keeps a copy here, apart from the database. Restore steps: infra/README.md, "Backups".

resource "azurerm_storage_account" "exports" {
  count = var.database_exports ? 1 : 0

  name                            = "stkitchenbak${var.environment}${local.suffix}"
  resource_group_name             = var.resource_group_name
  location                        = var.location
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  min_tls_version                 = "TLS1_2"
  allow_nested_items_to_be_public = false
  # Entra ID only: the backup job writes with its role assignment, never an account key.
  shared_access_key_enabled = false
  tags                      = merge(local.tags, { purpose = "database-exports" })

  blob_properties {
    # The backup job keeps the newest 8 exports and deletes older ones. A deleted or
    # overwritten export survives as a version (cleaned up by the policy below) and as a
    # soft-deleted blob, and the job's role can't delete versions.
    versioning_enabled = true

    delete_retention_policy {
      days = 30
    }

    container_delete_retention_policy {
      days = 30
    }
  }

  lifecycle {
    # Holds Prod's only copies of the database that outlive the server. Removing it takes
    # deleting this line first, on purpose.
    prevent_destroy = true
  }
}

resource "azurerm_storage_container" "exports" {
  count = var.database_exports ? 1 : 0

  name                  = "database-exports"
  storage_account_id    = azurerm_storage_account.exports[0].id
  container_access_type = "private"
}

# Versions left behind when the job prunes or overwrites an export are deleted 30 days
# later, so storage stays at about 8 exports.
resource "azurerm_storage_management_policy" "exports" {
  count = var.database_exports ? 1 : 0

  storage_account_id = azurerm_storage_account.exports[0].id

  rule {
    name    = "expire-old-export-versions"
    enabled = true

    filters {
      blob_types   = ["blockBlob"]
      prefix_match = ["${azurerm_storage_container.exports[0].name}/"]
    }

    actions {
      version {
        delete_after_days_since_creation = 30
      }
    }
  }
}

# The backup identity (kitchen-github-<env>-backup) may add, read and delete exports in
# this one container. Storage Blob Data Contributor can't delete blob versions or turn off
# soft delete, so it can't destroy the history either.
resource "azurerm_role_assignment" "exports_backup_identity" {
  count = var.database_exports && var.backup_identity_object_id != "" ? 1 : 0

  scope                = azurerm_storage_container.exports[0].id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = var.backup_identity_object_id
  principal_type       = "ServicePrincipal"
}
