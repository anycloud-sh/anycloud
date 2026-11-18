#!/bin/bash
# Azure Blob Storage helper functions for integration tests.
# Sourced by nuke.test.sh; deletion goes through the anycloud CLI.

delete_azure_container() {
    local container=$1
    cli_bucket delete "$container" --region "${AZURE_STORAGE_REGION:-eastus}"
}
