terraform {
  required_version = ">= 1.17.0, < 2.0.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 5.14"
    }
    azapi = {
      source  = "azure/azapi"
      version = "~> 2.14"
    }
  }
}
