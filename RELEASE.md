# Releasing anycloud

## Installation Methods

### Quick Install (Recommended)

```bash
curl -fsSL https://get.anycloud.sh | sh
```

This installs the current public release from `anycloud-sh/releases` to
`~/.local/bin/anycloud` without sudo (`/usr/local/bin` as root, or where an
earlier install already is) after verifying `checksums.txt`.

### Homebrew

```bash
brew install anycloud-sh/tap/anycloud
```

### Manual Download

Download the platform tarball and `checksums.txt` from the public release repo:

| Platform    | Asset                          |
| ----------- | ------------------------------ |
| Linux x64   | `anycloud-linux-x64.tar.gz`    |
| Linux ARM64 | `anycloud-linux-arm64.tar.gz`  |
| macOS x64   | `anycloud-darwin-x64.tar.gz`   |
| macOS ARM64 | `anycloud-darwin-arm64.tar.gz` |

Latest-release assets live at
`https://github.com/anycloud-sh/releases/releases/latest/download/<asset>`.
After downloading and verifying the asset against `checksums.txt`, extract
`anycloud` and move it to an install directory on `PATH`.

### Updating

For both installer-script and Homebrew installs:

```bash
anycloud update
```

For Homebrew-managed installs, `anycloud update` runs Homebrew first, then
reconciles any running local API server with the installed CLI version.

### Upgrading a running API server

If a local API server is running when you update, `anycloud update` restarts it on the matching image (same port) so you pick up a new release in one command.

```bash
anycloud update
anycloud api status          # confirm the new version is up
```

If the restart can't run (e.g. the binary isn't on `PATH`), finish it by hand with `anycloud api stop` then `anycloud api start`.

The CLI and the API container ship in lockstep — the installed CLI version selects the container tag, so the restart pulls the matching API image. Pending SQL migrations under `migrations/` apply automatically when the new container boots. Migrations are forward-only: an older API refuses to start against a database a newer API has used.

With a cluster-hosted API active, `anycloud api upgrade` then asks that API to move to the CLI's release; it backs its database up and patches its own Helm release. `anycloud api status` shows the served version and the latest upgrade. An image older than the served one is refused; going back means restoring the pre-upgrade backup. See [Hosted APIs](docs/platform/hosted-apis.md#upgrade-a-hosted-api).

## Release Line

Every release is published once and becomes the supported public release:

- CLI assets: `anycloud-sh/releases` tag `vX.Y.Z`, including platform tarballs and `checksums.txt`
- Homebrew formula: `anycloud-sh/homebrew-tap` formula `anycloud`
- API chart: `oci://ghcr.io/anycloud-sh/api-k8-chart:X.Y.Z`, published first; the API image names it by digest. Clusters pull it anonymously, so the `api-k8-chart` package must stay public (the chart job fails when it is not), and its **Manage Actions access** must grant `anycloud-sh/anycloud` write access: the package was created by hand, so the release's `GITHUB_TOKEN` cannot push to it otherwise.
- API image: `ghcr.io/anycloud-sh/api:X.Y.Z` and `ghcr.io/anycloud-sh/api:latest`
- Python SDK: `anycloud-sdk==X.Y.Z`

### Docs

Docs at [anycloud.sh](https://anycloud.sh) are a single canonical site — no version dropdown, no per-version snapshots. The CLI's `--help` output and the `anycloud update` command are the version contract for end users; the website always reflects the latest behavior.

The changelog at [anycloud.sh/changelog](https://anycloud.sh/changelog) is cumulative — newest version on top, full history kept. During development each change adds its own file under `changelog-unreleased/`, so concurrent pull requests never touch the same lines and an entry cannot drift into a version that already shipped. As part of the release PR, fold those files into the target release section:

```bash
yarn changelog:fold
```

The command takes no version: it derives the patch the release workflow will cut, writes that section above the newest existing one, and deletes the files it consumed. Commit the result, then dispatch the release workflow. The workflow refuses to publish if the package versions disagree, the release section is missing, or `changelog-unreleased/` still holds entries — the last case catches a change that merged after the release PR was prepared, whose note would otherwise ship under a later version than the code it describes. Re-run the same command to absorb it: when the section for the release being cut already exists, the fold appends into it. Because the target is derived from `package.json` rather than supplied, no run can reach a version that already published.

The release workflow copies that version's changelog section verbatim into the
GitHub release. Keep each entry to a descriptive heading and one paragraph: aim
for 25–40 words and never exceed 50. Describe the user-visible behavior, omit
implementation and test details, and link to the relevant documentation when
more explanation is useful.

### Skill (Claude plugin)

The agent skill in `anycloud-skills/` publishes to the public `anycloud-sh/anycloud-skills` repo (which backs the Claude plugin marketplace) on every push to `main` that touches it, via the **Publish Skill** workflow (`.github/workflows/skills.yml`). Content re-syncs per-commit, but the **manifest version is the marketplace's "update available" signal**, so it tracks the product version. The release workflow's **Bump version** step bumps `anycloud-skills/.claude-plugin/plugin.json` and `marketplace.json` to the new `X.Y.Z` alongside `package.json` (a CI gate enforces every manifest version field equals `package.json`). The bump commit carries `[skip ci]`, so it triggers no `on: push` workflow; the release's `skill` job then **dispatches** Publish Skill via `workflow_dispatch`, so each release reliably ships the matching skill version with no manual step. Publish Skill follows `CI_BACKEND` while Release stays GitHub-hosted, so when backmesh is down it waits for a runner, and GitHub fails it after 24 hours queued; dispatch it again once backmesh is back.

## Reserved Versions

Versioning was reset to `0.1.1` in April 2026. npm publishing has since been
decommissioned (see the 0.1.31 changelog — the CLI now ships as binaries to
`anycloud-sh/releases` + Homebrew, not npm), and the old `anycloud` npm package
is frozen. The version ranges below were burned by those prior npm publishes;
keep skipping them so version numbers stay unambiguous against that old history:

- `0.0.2` – `0.0.33`, `0.1.0`
- `0.3.0` – `0.3.17` (plus betas), `0.4.0` – `0.4.1` (plus betas), `0.5.0` – `0.5.4` (plus betas)
- `1.0.0`, `2.0.0` – `2.1.0`, `3.0.0` – `3.9.0`, `4.0.0` – `4.9.0`, `5.0.0` – `5.24.0`

When incrementing versions, skip these ranges. The clean path forward is:

```
0.1.x → 0.2.x → 0.6.x+ → 6.0.0+
```

(Skip `0.3`–`0.5` and `1`–`5` to avoid collisions with old publishes.)

## Coordinating a release

Coordinate each release from one issue opened from the **Release tracker**
template (`.github/ISSUE_TEMPLATE/release-tracker.md`). Its body is the source
of truth until the release ships: owner decisions, the merge gate, workstreams
and what each waits on, open owner questions, and how to resume. Any agent or
person taking over starts there. To close the release, the owner reads the
pending `changelog-unreleased/` entries as a digest, then run
`yarn changelog:fold` and [create the release](#creating-a-release).

## Creating a Release

Releases are **manually dispatched** from the `Release` workflow (`.github/workflows/release.yml`). These artifacts ship together and stay in lockstep:

- **CLI assets** in `anycloud-sh/releases` — bun-compiled platform tarballs plus `checksums.txt`
- **Homebrew formula** in `anycloud-sh/homebrew-tap`
- **Python SDK** `anycloud-sdk`
- **API Docker image** `ghcr.io/anycloud-sh/api` — multi-arch (amd64 + arm64)

### Release gate

Only `e2e-cluster-cloud`'s `hosted_stage` runs the CLI inside the API image,
which is how a CLI crash in that image once shipped. The Release workflow's prepare job refuses to release without a
successful run titled `E2E Cluster Tests [hosted_stage]` whose commit has the
tree being released.
Only a run on the release-built CLI (`compiled_cli`, on by default) carries
that title.

The fold changes the tree, so run `yarn changelog:fold` first, then dispatch
the hosted run on the folded release branch, or on `main` once it has merged:

```bash
gh workflow run e2e-cluster-cloud.yml --ref <branch> -f hosted_stage=true
```

Hold merges to `main` from that dispatch until the release is dispatched: any
merge in between changes the tree and needs a new hosted run. A release branch
merged with `main` unchanged keeps its tree.

On the same tree, dispatch the `storage-tokens` members and link the
green run on the release tracker:

```bash
gh workflow run e2e-job.yml --ref <branch> \
  -f tests=aws-storage-tokens,gcp-storage-tokens,azure-storage-tokens
```

Also dispatch the role-connection minting check on that tree, and link
its green run beside it:

```bash
gh workflow run e2e-cluster-cloud.yml --ref <branch> \
  -f hosted_stage=true -f live_checks=role-storage-tokens
```

**Break-glass:** only the owner, and only for an emergency release, skips the
gate by dispatching with a reason:

```bash
gh workflow run release.yml --ref main -f hosted_gate_waiver="<reason>"
```

The run summary records only that the gate was waived, and the release notes
not even that; the owner posts the reason on the release tracker. Right
after a waived release, dispatch the hosted run on its tag:

```bash
gh workflow run e2e-cluster-cloud.yml --ref v<X.Y.Z> -f hosted_stage=true
```

If that run fails, the failure blocks the next version's release until fixed.

### Trigger

GitHub Actions → **Release** → Run workflow against `main`. Or from the terminal:

```bash
gh workflow run release.yml --ref main
```

### What the workflow does

1. Requires the [release gate](#release-gate)'s hosted run. Bumps `package.json` patch (e.g. `0.1.13` → `0.1.14`), syncs `python/pyproject.toml` and the skill manifests (`anycloud-skills/.claude-plugin/plugin.json` + `marketplace.json`), validates the matching changelog section, commits as `Bump version to X.Y.Z`, and tags that final commit.
2. `yarn build` and `yarn test`. The **Style** workflow ran `yarn check:boundaries` and `yarn style` on that `main` commit when it was pushed, and the release does not re-check them; the version bump changes only version strings. **CI** runs only on pull requests, so the release reruns the build and tests on the merged tree.
3. Builds the platform tarballs (`yarn build:binaries`), which ad-hoc re-signs each macOS binary with a pinned `rcodesign` and fails unless `scripts/macho-signature.ts verify` accepts the signature (recent macOS kills Apple Silicon binaries carrying the signature Bun writes), smoke-tests the linux-x64 one from an empty directory, and stores them for the publish jobs. PR CI's `cli-piped-output` member runs the same build script for linux-x64 and both darwin targets.
4. Pushes the version-bump commit + tag to `main`.
5. Builds API platform images on `ubuntu-24.04` (amd64) and `ubuntu-24.04-arm` (arm64), retaining their immutable digests. Builds the SDK distributions once and qualifies both wheel and source distributions on Python 3.10 and 3.12. After these checks succeed, publishes the multi-arch manifest as `:X.Y.Z` and `:latest` from the retained digests.
6. Extracts the matching section from `docs/changelog.md`, then creates an immutable release with those notes, the platform tarballs, and `checksums.txt` in `anycloud-sh/releases` only after the matching API image tag exists. Publishing is create-only: an existing release fails rather than being modified.
7. Updates `anycloud-sh/homebrew-tap` to the new release assets and checksums.
8. Publishes the already-built Python SDK distributions as `X.Y.Z` to PyPI.
9. Dispatches the **Publish Skill** workflow (`workflow_dispatch`, because the `GITHUB_TOKEN` push won't trigger its `on: push`) to mirror the bumped skill to the public repo.

Every publish job checks out the exact version-bump commit produced by the prepare job, and the skill dispatch runs against the matching release tag. A later commit to `main` cannot mix source revisions into an in-flight release. Managed GPU qualification runs separately and is not a publication prerequisite.

Use **Re-run failed jobs** in the original Release run to retry a failure.
Completed jobs retain their outputs, while failed preparation can run again.

Neither the release nor CI launches the darwin binaries on real Mac hardware. GitHub-hosted macOS runners bill at about 10× Linux against a capped Actions budget, so the owner removed the `cli-macos` job (2026-11-08). The darwin binaries are built, re-signed and checked with `scripts/macho-signature.ts verify` on Linux, in PR CI's `cli-piped-output` member and in the release build; a launch failure on macOS that passes that check would only show up after publishing.

### CI artifact storage and retry windows

Actions artifact storage uses the organization's shared free allowance. The
`actions_storage` SKU has a $0 budget with usage blocking enabled; the existing
Actions compute budget is separate. Deleting artifacts stops future storage
accrual but does not restore usage already recorded this month. GitHub can still
reject uploads when the monthly allowance is exhausted.
Allow 6–12 hours for storage usage reports to reflect cleanup; see
[GitHub's billing rules](https://docs.github.com/en/billing/concepts/product-billing/github-actions#understanding-current-vs-accrued-storage).

The **Actions Artifact Cleanup** workflow cleans completed runs after artifact
producers finish, hourly, and before release/GPU candidate production. Cleanup
executes code from the default branch. Its target for retained completed-run
artifacts is 20 MiB through September 30, 2026, and 250 MiB from October 1 (UTC).
Running/queued inputs, recovery evidence, mutation reports, and unclassified
artifacts are protected even when that prevents reaching the target.
Release-source artifacts are also protected while managed qualification is active.

API responsiveness comparisons and billing integration measurements are required
performance evidence. They upload on success and failure, fail CI if missing, and
remain protected from storage-pressure cleanup for seven days after upload.
Cleanup expires them once that review window ends.

Successful GPU candidates are removed. The newest failed GPU candidate and
newest completed release's CLI, SDK, and digest artifacts may remain for up to
24 hours after completion, subject to available space. Release artifacts are
evicted together. Their seven-day automatic expiration is a fallback for missed
cleanup runs, not a guaranteed retry window. `release_artifact_run_id` only works
while its source artifacts remain available. Once bytes are pruned or expired,
start a fresh workflow dispatch; an existing candidate retry cannot rebuild them.

Ordinary SDK transfer artifacts expire after one day and are removed after
successful consumption. Diagnostic logs are uploaded for failed/cancelled tests,
including allowed-to-fail steps, and kept for at most three days or until storage
pressure requires eviction. Optional log-upload failures do not change the test
result. Required downloads, qualification receipts, and cleanup-authority uploads
still fail when unavailable. Compact GPU recovery/qualification records and
Lambda instance cleanup ledgers remain for 30 days. Historical qualification
archives containing these records are preserved until their original expiration.
Mutation campaign HTML/JSON reports are uploaded after successful and failed
runs and remain protected until their seven-day GitHub expiration. Missing
reports fail their upload step.

Preview or apply cleanup locally with an authenticated `gh` session:

```bash
node ci/cleanup/actions-artifacts.mjs --repo anycloud-sh/anycloud --dry-run
node ci/cleanup/actions-artifacts.mjs --repo anycloud-sh/anycloud --run-id RUN_ID
node ci/cleanup/actions-artifacts.mjs --repo anycloud-sh/anycloud --apply --output cleanup.json
```

Manual workflow dispatch defaults to preview; set `apply=true` to delete eligible
artifacts. A run ID limits inspection and deletion to that run; repository-wide
sweeps enforce the shared target and newest-run rules across producers. Each pass
bounds owner lookups and deletions to avoid monopolizing GitHub's API allowance;
`--max-runs` and `--max-deletes` can raise those limits for an operator cleanup.
Status checks use conditional requests, with GitHub confirming unchanged runs,
and deletions are paced to respect its mutation limits.
Job summaries report selected/deleted IDs, reasons, accounted storage, protected
data, and unfinished work. Later hourly passes continue partial cleanup. Workflow
history and native job logs remain available for investigation and recovery.

### Manual recovery after runner loss

The retired managed-Kubernetes GPU qualification (`managed-kubernetes-qualification.yml`,
removed 2026-09-25 with the independent Cluster surface) uploaded an immutable
cleanup authority and candidate manifest before GPU provisioning. Retained
attempts can still be recovered while their artifacts exist.

For an abandoned attempt with an explicit AWS host/state region and Azure
capacity region, `ci/cleanup/managed-gpu-run.ts` runs from a fresh checkout
without the original runner or API. With `GH_TOKEN`, the original AWS/Azure
credentials, and `E2E_SERVE_GITHUB_TOKEN` available, run:

```bash
GITHUB_REPOSITORY=anycloud-sh/anycloud yarn tsx ci/cleanup/managed-gpu-run.ts \
  cleanup ORIGINAL_RUN_ID ORIGINAL_ATTEMPT recovery.json
```

The manual **Manual Managed GPU Recovery** workflow wraps the same command.
Recovery verifies the
completed original workflow attempt and downloaded authority archive before
using its account and region constraints. It confirms AWS host termination,
removes the run's owned Azure capacity and AWS supporting resources, and
confirms DNS and checkpoint-bucket removal. Checkpoint deletion waits for
confirmed controller, capacity, supporting-resource, and DNS cleanup. Provider
errors, conflicting ownership, or residual resources keep recovery unconfirmed.
Shared provider infrastructure is outside this run's cleanup scope.

The recovery receipt records covered providers, resource kinds, and remaining
resources. It does not rewrite qualification results. Automatic recovery and
recovery for other provider combinations remain deferred; GCP firewall ownership
is not covered by this bounded AWS/Azure path.

### Authentication

Main-repo operations use built-in tokens. Cross-repo public release and
Homebrew tap updates use `E2E_SERVE_GITHUB_TOKEN`.

- **CLI release assets**: `E2E_SERVE_GITHUB_TOKEN` for `anycloud-sh/releases`
- **Homebrew tap**: `E2E_SERVE_GITHUB_TOKEN` for `anycloud-sh/homebrew-tap`
- **PyPI**: OIDC trusted publishing (`pypi` environment)
- **GHCR**: `GITHUB_TOKEN` with `packages: write`
- **Git push**: `GITHUB_TOKEN` with `contents: write`

### Verify

```bash
VERSION="$(node -p "require('./package.json').version")"
gh release view "v${VERSION}" --repo anycloud-sh/releases --json tagName,isLatest,assets
curl -fsSL "https://github.com/anycloud-sh/releases/releases/download/v${VERSION}/checksums.txt"
brew update
brew info anycloud-sh/tap/anycloud
docker manifest inspect ghcr.io/anycloud-sh/api:latest | jq '.manifests[].platform'
anycloud --version
```

### Rollback

Publish a new patch from the previous commit, then dispatch the workflow again:

```bash
git revert HEAD
git push
# then trigger the Release workflow
```

A local API stays on its current image until `anycloud update` or `anycloud api stop && anycloud api start` restarts it, and a cluster-hosted API until `anycloud api upgrade` moves it (see "Upgrading a running API server" above).

## Architecture

- **Development**: Node.js + TypeScript
- **Compilation**: Bun (creates standalone binaries, no Node.js required on user machines)
- **Distribution**: public GitHub release assets in `anycloud-sh/releases`, with a Homebrew tap for macOS and Linuxbrew users
- **Install script**: Hosted on Cloudflare Workers at get.anycloud.sh

## Supported Platforms

| Platform | Architecture          | Binary                |
| -------- | --------------------- | --------------------- |
| Linux    | x64                   | anycloud-linux-x64    |
| Linux    | ARM64                 | anycloud-linux-arm64  |
| macOS    | x64 (Intel)           | anycloud-darwin-x64   |
| macOS    | ARM64 (Apple Silicon) | anycloud-darwin-arm64 |
