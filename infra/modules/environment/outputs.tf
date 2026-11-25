output "static_web_app_name" {
  value = azurerm_static_web_app.web.name
}

output "web_url" {
  value = "https://${azurerm_static_web_app.web.default_host_name}"
}

output "function_app_name" {
  value = azurerm_function_app_flex_consumption.api.name
}

output "api_url" {
  value = "https://${azurerm_function_app_flex_consumption.api.default_hostname}"
}

output "function_app_principal_id" {
  description = "Object ID of the API's managed identity, used when a migration creates its database user."
  value       = azurerm_function_app_flex_consumption.api.identity[0].principal_id
}

output "key_vault_name" {
  value = azurerm_key_vault.this.name
}

output "key_vault_uri" {
  value = azurerm_key_vault.this.vault_uri
}

output "sql_server_name" {
  value = azurerm_mssql_server.this.name
}

output "sql_server_fqdn" {
  value = azurerm_mssql_server.this.fully_qualified_domain_name
}

output "app_database_name" {
  value = azapi_resource.app_database.name
}

output "auth_client_id" {
  description = "The web app signs in with this app registration; the deploy writes it to config.json."
  value       = var.auth_client_id
}

output "tenant_id" {
  value = data.azurerm_client_config.current.tenant_id
}

output "settings" {
  description = "The choices that set this environment apart, read from the resources themselves, so an environment root's tests can check what it passed in. Nothing here is secret."
  value = {
    resource_group_name        = azurerm_key_vault.this.resource_group_name
    location                   = azurerm_mssql_server.this.location
    sql_admin_login            = azurerm_mssql_server.this.azuread_administrator[0].login_username
    sql_admin_object_id        = azurerm_mssql_server.this.azuread_administrator[0].object_id
    database_uses_free_offer   = azapi_resource.app_database.body.properties.useFreeLimit
    key_vault_purge_protection = azurerm_key_vault.this.purge_protection_enabled
    api_allowed_origins        = azapi_resource_action.api_cors.body.properties.cors.allowedOrigins
  }
}
