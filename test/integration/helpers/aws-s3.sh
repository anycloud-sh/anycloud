# AWS S3 helper functions for integration tests

aws_storage_region() {
    echo "${AWS_STORAGE_REGION:-us-east-1}"
}

create_s3_bucket() {
    local bucket=$1
    # Route through `anycloud bucket create` so the bucket gets tagged with
    # anycloud_user/_workload/_created_at — the CI storage sweep picks it
    # up automatically if the test trap doesn't run.
    cli_bucket create "$bucket" --region "$(aws_storage_region)"
}

delete_s3_bucket() {
    local bucket=$1
    # Route through `anycloud bucket delete` so the bucket is tagged with
    # ended_at before objects are dropped — if delete fails partway, the CI
    # storage sweep picks up the residual on the next pass.
    cli_bucket delete "$bucket" --region "$(aws_storage_region)"
}
