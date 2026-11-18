#!/usr/bin/env bash
set -euo pipefail

# Provider errors name the CI AWS account in IAM ARNs (a restricted key's
# AccessDenied, for one). `mask` hides it in every later log line of this job;
# `scrub FILE...` removes it, and any account in an ARN, from files before
# they are uploaded as artifacts. Fails unless STS returns a 12-digit account.
account="$(aws sts get-caller-identity --query Account --output text)"
if [[ ! "$account" =~ ^[0-9]{12}$ ]]; then
    printf 'Could not read the AWS account ID to redact.\n' >&2
    exit 1
fi

case "${1:-}" in
    mask)
        printf '::add-mask::%s\n' "$account"
        ;;
    scrub)
        shift
        for file in "$@"; do
            [[ -f "$file" ]] || continue
            sed -i -E \
                -e "s/${account}/[REDACTED]/g" \
                -e 's/(arn:aws[a-z-]*:[a-z0-9-]*:[a-z0-9-]*:)[0-9]{12}/\1[REDACTED]/g' \
                "$file"
        done
        ;;
    *)
        printf 'usage: %s mask | scrub FILE...\n' "$0" >&2
        exit 2
        ;;
esac
