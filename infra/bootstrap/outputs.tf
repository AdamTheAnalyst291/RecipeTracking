output "subscription_id" {
  value = var.subscription_id
}

output "tenant_id" {
  value = var.tenant_id
}

output "state_resource_group" {
  value = azurerm_resource_group.state.name
}

output "state_storage_account" {
  value = azurerm_storage_account.state.name
}

output "deploy_identities" {
  description = "Per environment: the deploy identity's client ID and service principal object ID, for the GitHub Environment's variables."
  value = {
    for e in var.environments : e => {
      client_id    = azuread_application.deploy[e].client_id
      principal_id = azuread_service_principal.deploy[e].object_id
    }
  }
}

output "backup_identities" {
  description = "Per backed-up environment: the backup identity's client ID and service principal object ID, for the <env>-backup GitHub Environment and the <env> environment's AZURE_BACKUP_* variables."
  value = {
    for e in local.backup_environments : e => {
      client_id    = azuread_application.backup[e].client_id
      principal_id = azuread_service_principal.backup[e].object_id
    }
  }
}

output "warehouse_identities" {
  description = "Per environment with a nightly warehouse build: the warehouse identity's client ID and service principal object ID, for the <env>-warehouse GitHub Environment and the <env> environment's AZURE_WAREHOUSE_* variables."
  value = {
    for e in local.warehouse_environments : e => {
      client_id    = azuread_application.warehouse[e].client_id
      principal_id = azuread_service_principal.warehouse[e].object_id
    }
  }
}
