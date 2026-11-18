#!/usr/bin/env bash
set -euo pipefail

# ci/install-runner-tools.sh installs the cloud CLIs. Check the shared baseline before a
# test authenticates or creates resources; fixtures own their credentials.
for tool in aws az gcloud gsutil; do
    if ! command -v "$tool" > /dev/null 2>&1; then
        printf 'CI runner is missing %s; run ci/install-runner-tools.sh before running cloud tests.\n' "$tool" >&2
        exit 1
    fi
done

aws --version
az version --output none
gcloud --version
gsutil version
