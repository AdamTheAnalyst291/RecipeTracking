variable "environment" {
  description = "Environment name: dev, uat or prod."
  type        = string

  validation {
    condition     = contains(["dev", "uat", "prod"], var.environment)
    error_message = "environment must be dev, uat or prod."
  }
}

variable "resource_group_name" {
  description = "Existing resource group for this environment, created by infra/bootstrap."
  type        = string
}

variable "location" {
  description = "Azure region for every resource in this environment. All free Azure SQL databases in a subscription must share one region."
  type        = string
}

variable "sql_admin" {
  description = "Microsoft Entra principal that administers the SQL server. The server accepts Entra sign-in only, so no password exists."
  type = object({
    login_username = string
    object_id      = string
  })
}

variable "function_maximum_instance_count" {
  description = "Upper limit on Functions instances, which caps cost if something calls the API in a loop."
  type        = number
  default     = 40
}

variable "key_vault_purge_protection" {
  description = "Stops a deleted Key Vault (the main one and the token vault) from being purged before its retention ends. Off for Dev so it can be torn down and rebuilt; turn it on for Prod. Once on, it can't be turned off."
  type        = bool
  default     = false
}

variable "plaid_environment" {
  description = "Which Plaid the bank sync talks to (card $2): sandbox in Dev, production in Prod. The plaid-secret in the environment's vault must be that environment's."
  type        = string
  default     = "sandbox"

  validation {
    condition     = contains(["sandbox", "production"], var.plaid_environment)
    error_message = "plaid_environment must be sandbox or production."
  }
}

variable "auth_client_id" {
  description = "Client ID of the kitchen's Entra app registration for this environment, created by hand (infra/README.md, \"Sign-in\"). Empty until it exists; the API then refuses every request that needs sign-in."
  type        = string
  default     = ""

  validation {
    condition     = var.auth_client_id == "" || can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.auth_client_id))
    error_message = "auth_client_id must be empty or an app registration's client ID (a lowercase GUID)."
  }
}

variable "database_exports" {
  description = "Turns on the weekly export of the app database (card S2): a storage account and container for the exports. Prod only."
  type        = bool
  default     = false
}

variable "warehouse_identity_object_id" {
  description = "Service principal object ID of the warehouse identity (kitchen-github-<env>-warehouse), which runs the nightly dbt build (card W1) and may read the ntfy-topic secret for its failure alert. Empty until infra/bootstrap creates it; nothing is granted until then. The ntfy-topic secret must exist in the main vault first."
  type        = string
  default     = ""

  validation {
    condition     = var.warehouse_identity_object_id == "" || can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.warehouse_identity_object_id))
    error_message = "warehouse_identity_object_id must be empty or a service principal's object ID (a lowercase GUID)."
  }
}

variable "backup_identity_object_id" {
  description = "Service principal object ID of the backup identity (kitchen-github-<env>-backup), which may write the exports. Empty until infra/bootstrap creates it; nobody is granted the exports until then. Needs database_exports."
  type        = string
  default     = ""

  validation {
    condition     = var.backup_identity_object_id == "" || can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.backup_identity_object_id))
    error_message = "backup_identity_object_id must be empty or a service principal's object ID (a lowercase GUID)."
  }
}
