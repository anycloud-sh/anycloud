#!/bin/bash
# GCP Cloud Storage helper functions for integration tests.
# Requires: GCP_PROJECT_ID, GCP_PRIVATE_KEY, GCP_CLIENT_EMAIL
# Must call setup_gcp_auth before using delete_gcs_bucket.

setup_gcp_auth() {
    require_gcp_credentials
    export GCP_BOOTSTRAP_CLIENT_EMAIL="$GCP_CLIENT_EMAIL"

    if ! command -v gcloud &> /dev/null; then
        print_error "gcloud CLI not found"
        print_info "Please install gcloud CLI: https://cloud.google.com/sdk/docs/install"
        exit 1
    fi
    print_success "gcloud CLI installed"

    # Isolate gcloud config per test process. e2e.sh runs gcp tests in parallel,
    # and `gcloud auth activate-service-account --project=...` writes to the
    # shared ~/.config/gcloud/configurations/config_default; concurrent writes
    # produce a file with duplicate `project=` lines that subsequent gsutil
    # invocations refuse to parse (configparser.DuplicateOptionError).
    export CLOUDSDK_CONFIG="$(mktemp -d)"

    gcloud auth activate-service-account "$GCP_CLIENT_EMAIL" \
        --key-file=<(jq -n \
          --arg projectId "$GCP_PROJECT_ID" \
          --arg privateKey "$GCP_PRIVATE_KEY" \
          --arg clientEmail "$GCP_CLIENT_EMAIL" \
          '{
            type: "service_account",
            project_id: $projectId,
            private_key: $privateKey,
            client_email: $clientEmail,
            auth_uri: "https://accounts.google.com/o/oauth2/auth",
            token_uri: "https://oauth2.googleapis.com/token"
          }') \
        --project="$GCP_PROJECT_ID" > /dev/null 2>&1
    if [ $? -ne 0 ]; then
        print_error "Failed to authenticate with GCP service account"
        exit 1
    fi
    print_success "Authenticated with GCP service account"
}

delete_gcs_bucket() {
    cli_bucket delete "$1" --region "${GCP_STORAGE_REGION:-us-central1}"
}
