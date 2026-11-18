#!/bin/bash

# Provider-native Azure quota matching used by the credentialed quota E2E.
# Both functions shell out to the real TypeScript resolvers
# (src/shared/quota-resolvers/azure-identity.ts, azure-public-ip.ts) via
# test/integration/helpers/azure-quota-*.ts, so there is exactly one
# implementation of quota
# matching in the repo instead of a second, hand-maintained jq mirror of it.
# Keep these functions sourceable so credential-free unit tests can exercise
# the wiring directly.

azure_quota_parity_repo_root() {
    cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd
}

azure_public_ip_selection() {
    local network_quota_file=$1
    local repo_root
    repo_root="$(azure_quota_parity_repo_root)"
    # TSV: semantic resource key, numeric limit, localized name, exact provider ID.
    (cd "$repo_root" && npx tsx test/integration/helpers/azure-quota-public-ip-selection.ts \
        --network-quota-file "$network_quota_file")
}

azure_compute_provider_limit() {
    local resource_key=$1 compute_usage_file=$2 compute_quota_file=$3
    local repo_root
    repo_root="$(azure_quota_parity_repo_root)"
    (cd "$repo_root" && npx tsx test/integration/helpers/azure-quota-compute-limit.ts \
        --resource-key "$resource_key" \
        --compute-usage-file "$compute_usage_file" \
        --compute-quota-file "$compute_quota_file")
}
