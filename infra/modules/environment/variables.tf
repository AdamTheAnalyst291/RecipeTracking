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
  description = "Stops a deleted Key Vault from being purged before its retention ends. Off for Dev so it can be torn down and rebuilt; turn it on for Prod. Once on, it can't be turned off."
  type        = bool
  default     = false
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
  description = "Turns on the weekly export of the app database (card S2): a storage account for the exports, and write access for the backup identity whose service principal object ID is reader_object_id. Leave reader_object_id empty until that identity exists. null (the default) creates nothing."
  type = object({
    reader_object_id = string
  })
  default = null

  validation {
    condition     = var.database_exports == null || var.database_exports.reader_object_id == "" || can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.database_exports.reader_object_id))
    error_message = "database_exports.reader_object_id must be empty or a service principal's object ID (a lowercase GUID)."
  }
}
