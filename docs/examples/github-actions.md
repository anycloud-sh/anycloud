---
title: Run GPU tests from GitHub Actions
description: Give CI its own account on a hosted API and run a nightly GPU Job that fails the workflow when the tests fail.
---

# Run GPU tests from GitHub Actions

This example runs a test suite on an L40S GPU every night from GitHub Actions.
The workflow submits a Job to a [hosted API](/platform/hosted-apis), waits for
it, and fails when the Job fails.

## Before you begin

You need:

- A hosted API, and its URL (`https://<cluster-id>.anycloud.sh`)
- A cloud credential saved on that API, for example `my-aws`. Credentials on a
  hosted API are shared by everyone with access, so CI can use an existing one.
- A test image, such as `ghcr.io/acme/tests:latest`, with your GPU tests as its
  command
- A GitHub account for CI. A separate account is best: CI acts as the account
  whose token it holds, and its Jobs are listed under that account.

## 1. Give CI a token

As the API's owner, add the CI account:

```bash
anycloud api use https://<cluster-id>.anycloud.sh
anycloud api access add acme-ci
```

Signed in as the CI account, get its API token:

```bash
anycloud login https://<cluster-id>.anycloud.sh
anycloud api token
```

In the repository's Actions settings, save the token as the secret
`ANYCLOUD_API_TOKEN` and the API URL as the variable `ANYCLOUD_API_URL`.

## 2. Add the workflow

Create `.github/workflows/gpu-nightly.yml`:

```yaml
name: GPU nightly

on:
  schedule:
    - cron: '0 9 * * *'
  workflow_dispatch:

jobs:
  gpu-tests:
    runs-on: ubuntu-latest
    env:
      API_URL: ${{ vars.ANYCLOUD_API_URL }}
      ANYCLOUD_API_TOKEN: ${{ secrets.ANYCLOUD_API_TOKEN }}
    steps:
      - name: Install Anycloud
        run: |
          curl -fsSL https://get.anycloud.sh | sh
          echo "$HOME/.local/bin" >> "$GITHUB_PATH"
      - name: Run the tests on an L40S
        run: |
          anycloud job ghcr.io/acme/tests:latest \
            --gpu-type l40s \
            --gpus all \
            --credentials my-aws \
            --wait
```

`ANYCLOUD_API_TOKEN` is used only when `API_URL` names the API that issued it.
`--wait` exits `0` when the Job succeeds and `1` when it fails, so the workflow
fails with it; see [`anycloud wait`](/reference/cli/workloads#anycloud-wait) for
the other exit codes. Use `anycloud logs <job-id>` to read the Job's output.

## Keep it working

- **Rotating the CI account's token stops the workflow.** After
  `anycloud api token rotate`, update the `ANYCLOUD_API_TOKEN` secret.
- **Private images need the CI account's GitHub sign-in.** The hosted API pulls
  them with the sign-in from that account's last `anycloud login <api-url>`.
  When an image error names that command, run it again as the CI account.
  Signing the CI account in more than ten times elsewhere revokes that copy;
  see [`GITHUB_SIGN_IN_REQUIRED`](/troubleshooting#github_sign_in_required).

See [API tokens](/reference/cli/api-utilities#api-tokens) for rotation and
leaked-token recovery.
