# One-time setup, applied by hand by the subscription owner (see infra/README.md).
# Copied from Setlist's infra/bootstrap and adapted for the kitchen app (ADR-25).
# It creates what the environment roots can't create for themselves:
#   - the resource providers the kitchen app uses, registered on the subscription
#   - a small storage account holding Terraform state, one container per environment
#   - per environment: a resource group, and a GitHub deploy identity that trusts only
#     this repository's GitHub Environment of the same name, with rights on that group
#     and on that environment's state container only
#   - the kitchen's monthly budget alert, counting only the kitchen's resource groups
# The subscription (My-VibeCode) also holds Setlist, which has its own bootstrap.

terraform {
  required_version = ">= 1.17.0, < 2.0.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.81"
    }
    azuread = {
      source  = "hashicorp/azuread"
      version = "~> 3.10"
    }
  }

  # State stays local (terraform.tfstate, git-ignored). It is small and can be
  # rebuilt with terraform import if lost.
}

provider "azurerm" {
  features {}

  # Pinned explicitly so this never runs against whichever subscription the Azure CLI
  # happens to have selected.
  subscription_id = var.subscription_id
  tenant_id       = var.tenant_id

  resource_provider_registrations = "none"
  resource_providers_to_register = [
    "Microsoft.Consumption",
    "Microsoft.Insights", # Application Insights, for the API's logs
    "Microsoft.KeyVault",
    "Microsoft.ManagedIdentity",
    "Microsoft.OperationalInsights", # its Log Analytics workspace
    "Microsoft.Sql",
    "Microsoft.Storage",
    "Microsoft.Web",
  ]

  storage_use_azuread = true
}

provider "azuread" {
  tenant_id = var.tenant_id
}

locals {
  suffix = substr(sha1(var.subscription_id), 0, 6)
  tags = {
    app        = "kitchen"
    managed_by = "terraform-bootstrap"
  }

  state_resource_group_name = "rg-kitchen-tfstate"
  environment_resource_group_names = {
    for e in var.environments : e => "rg-kitchen-${e}"
  }

  # Roles the deploy identities may hand out inside their own resource group: to the
  # API's managed identity, to the backup identity on the export container (card S2),
  # and Key Vault Secrets Officer for the API's identity on the token-only vault, where
  # the API writes bank tokens (card $2, PR #54). Nothing else, so a deploy identity
  # can't make itself Owner.
  delegable_role_ids = [
    "b7e6dc6d-f1e8-4753-8033-0f276bb0955b", # Storage Blob Data Owner
    "4633458b-17de-408a-b874-0445c86b69e6", # Key Vault Secrets User
    "ba92f5b4-2d11-453d-a403-e96b0029c9fe", # Storage Blob Data Contributor
    "b86a8fe4-44ce-4948-aee5-eccb2c155cd7", # Key Vault Secrets Officer
  ]

  # Environments whose database is exported weekly (card S2). Each gets a backup
  # identity of its own, so the scheduled job never signs in as the deploy identity.
  backup_environments = setintersection(var.environments, ["prod"])
  delegable_roles     = join(", ", local.delegable_role_ids)
}

# --- Terraform state -----------------------------------------------------------

resource "azurerm_resource_group" "state" {
  name     = local.state_resource_group_name
  location = var.location
  tags     = local.tags
}

resource "azurerm_storage_account" "state" {
  name                            = "stkitchentf${local.suffix}"
  resource_group_name             = azurerm_resource_group.state.name
  location                        = azurerm_resource_group.state.location
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  min_tls_version                 = "TLS1_2"
  allow_nested_items_to_be_public = false
  # Entra ID only: state is read with role assignments, never an account key.
  shared_access_key_enabled = false
  tags                      = local.tags

  blob_properties {
    versioning_enabled = true

    delete_retention_policy {
      days = 7
    }

    container_delete_retention_policy {
      days = 7
    }
  }
}

resource "azurerm_storage_container" "state" {
  for_each = var.environments

  name                  = "tfstate-${each.key}"
  storage_account_id    = azurerm_storage_account.state.id
  container_access_type = "private"
}

# --- Per environment -----------------------------------------------------------

resource "azurerm_resource_group" "environment" {
  for_each = var.environments

  name     = local.environment_resource_group_names[each.key]
  location = var.location
  tags     = merge(local.tags, { environment = each.key })
}

resource "azuread_application" "deploy" {
  for_each = var.environments

  display_name = "kitchen-github-${each.key}"
}

resource "azuread_service_principal" "deploy" {
  for_each = var.environments

  client_id = azuread_application.deploy[each.key].client_id
}

# The only way to sign in as this identity: a GitHub Actions job in this repository
# that runs in the GitHub Environment of the same name. No client secret exists.
resource "azuread_application_federated_identity_credential" "github_environment" {
  for_each = var.environments

  application_id = azuread_application.deploy[each.key].id
  display_name   = "github-${replace(var.github_repository, "/", "-")}-${each.key}"
  description    = "GitHub Actions in ${var.github_repository}, environment ${each.key}"
  issuer         = "https://token.actions.githubusercontent.com"
  subject        = "${var.github_oidc_subject_prefix}:environment:${each.key}"
  audiences      = ["api://AzureADTokenExchange"]
}

resource "azurerm_role_assignment" "deploy_contributor" {
  for_each = var.environments

  scope                = azurerm_resource_group.environment[each.key].id
  role_definition_name = "Contributor"
  principal_id         = azuread_service_principal.deploy[each.key].object_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_role_assignment" "deploy_role_assignments" {
  for_each = var.environments

  scope                = azurerm_resource_group.environment[each.key].id
  role_definition_name = "Role Based Access Control Administrator"
  principal_id         = azuread_service_principal.deploy[each.key].object_id
  principal_type       = "ServicePrincipal"
  description          = "Lets Terraform grant the API's managed identity its storage and Key Vault roles, and the backup identity its export container role, and nothing else."

  condition_version = "2.0"
  condition         = <<-EOT
    (
     (
      !(ActionMatches{'Microsoft.Authorization/roleAssignments/write'})
     )
     OR
     (
      @Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${local.delegable_roles}}
     )
    )
    AND
    (
     (
      !(ActionMatches{'Microsoft.Authorization/roleAssignments/delete'})
     )
     OR
     (
      @Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${local.delegable_roles}}
     )
    )
  EOT
}

resource "azurerm_role_assignment" "deploy_state" {
  for_each = var.environments

  scope                = azurerm_storage_container.state[each.key].id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azuread_service_principal.deploy[each.key].object_id
  principal_type       = "ServicePrincipal"
}

# --- Backup identity (card S2) ---------------------------------------------------

# Runs the weekly database export (.github/workflows/backup-prod.yml). It signs in only
# from the GitHub Environment <env>-backup, which has no required reviewer (a scheduled
# job can't wait for one) but allows main only. That is why it is a separate identity
# with far less than the deploy identity: no Azure role here at all. Prod's Terraform
# gives it Storage Blob Data Contributor on the export container, and the Deploy Prod
# migration step makes it a read-only database user (db_datareader, VIEW DEFINITION).
resource "azuread_application" "backup" {
  for_each = local.backup_environments

  display_name = "kitchen-github-${each.key}-backup"
}

resource "azuread_service_principal" "backup" {
  for_each = local.backup_environments

  client_id = azuread_application.backup[each.key].client_id
}

resource "azuread_application_federated_identity_credential" "backup_environment" {
  for_each = local.backup_environments

  application_id = azuread_application.backup[each.key].id
  display_name   = "github-${replace(var.github_repository, "/", "-")}-${each.key}-backup"
  description    = "GitHub Actions in ${var.github_repository}, environment ${each.key}-backup"
  issuer         = "https://token.actions.githubusercontent.com"
  subject        = "${var.github_oidc_subject_prefix}:environment:${each.key}-backup"
  audiences      = ["api://AzureADTokenExchange"]
}

# --- Budget --------------------------------------------------------------------

# A subscription budget filtered to the kitchen's resource groups (state included),
# because Setlist shares the subscription and has its own budget.
resource "azurerm_consumption_budget_subscription" "kitchen" {
  name            = "kitchen-monthly"
  subscription_id = "/subscriptions/${var.subscription_id}"
  amount          = var.budget_amount
  time_grain      = "Monthly"

  time_period {
    # Budgets must start on the first of a month.
    start_date = formatdate("YYYY-MM-01'T'00:00:00Z", plantimestamp())
  }

  filter {
    dimension {
      name     = "ResourceGroupName"
      operator = "In"
      values = concat(
        [local.state_resource_group_name],
        [for e in sort(tolist(var.environments)) : local.environment_resource_group_names[e]],
      )
    }
  }

  notification {
    enabled        = true
    operator       = "GreaterThanOrEqualTo"
    threshold      = 50
    threshold_type = "Actual"
    contact_emails = [var.budget_contact_email]
  }

  notification {
    enabled        = true
    operator       = "GreaterThanOrEqualTo"
    threshold      = 100
    threshold_type = "Actual"
    contact_emails = [var.budget_contact_email]
  }

  notification {
    enabled        = true
    operator       = "GreaterThanOrEqualTo"
    threshold      = 100
    threshold_type = "Forecasted"
    contact_emails = [var.budget_contact_email]
  }

  lifecycle {
    ignore_changes = [time_period]
  }
}
