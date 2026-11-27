# Experiments

An experiment is a temporary executable proof supporting an issue or design
decision. Each `experiments/<name>/` directory has a `run.ts` entrypoint and a
README recording status, the decision, run instructions, promotion
criteria, and deletion criteria. Fixtures and assertions belong under `test/`.
See [directory ownership](../CONTRIBUTING.md#directory-ownership).

## GitHub Actions

The shared [Spike workflow](../.github/workflows/spike.yml) is a manually
dispatched runner. Select the workflow on `main`, then provide:

| Input                | Meaning                                                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `experiment`         | One directory name under `experiments/`.                                                                                                      |
| `source_sha`         | Full immutable commit SHA containing the experiment and `ci/run-spike.ts`.                                                                    |
| `arguments`          | JSON array of literal command arguments; no shell expansion.                                                                                  |
| `cleanup_arguments`  | JSON argument array for a separate cleanup invocation, including after failure. Leave empty only for an experiment that creates no resources. |
| `azure_subscription` | `default` passes CI's Azure secrets; `own` passes our subscription's (`AZURE_OWN_*`) under the same variable names.                           |

The workflow definition is published on `main` once. Later experiments can run
from a pushed feature-branch commit containing the shared runner. The workflow
passes every cloud credential CI holds, using the integration workflow's names
for AWS, Azure, GCP, and Lambda: AWS (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
`AWS_SESSION_TOKEN`), Azure (`AZURE_SUBSCRIPTION_ID`, `AZURE_TENANT_ID`,
`AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`), GCP (`GCP_PROJECT_ID`,
`GCP_CLIENT_EMAIL`, `GCP_PRIVATE_KEY`), `LAMBDA_API_KEY`, Modal
(`MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`), `CLOUDFLARE_API_TOKEN`, and the public API-TLS origin-pull CA certificate
(`ORIGIN_PULL_CA`). That Cloudflare token also deploys the website, the
`get.anycloud.sh` installer, and the DNS and Slack Workers, so choose the
`source_sha` with care. A cloud with no CI secret needs one added first. Dispatch
executes code from the selected commit; the directory check is not a sandbox,
so use a commit whose code and dependencies have been reviewed.

Runs are named `Spike: <experiment> @ <source_sha>`. They are manually selected
investigations; normal build, test, release, and standing qualification workflows
retain their own triggers and contracts. New experiments should use this runner
when its execution and credential profiles fit.

### Removed dedicated launchers

The Azure spot-restart, Lambda boot, Lambda runtime-image, Azure GHCR throughput,
and placeholder GitHub-controlled-API spike workflow files have been removed.
Executable investigations retain these direct entrypoints:

| Investigation                    | Direct entrypoint                                        |
| -------------------------------- | -------------------------------------------------------- |
| Azure spot-restart race          | `yarn spike:azure-spot-restart-race`                     |
| Azure failed-allocation recovery | `yarn spike:azure-spot-restart-recovery`                 |
| Lambda boot observations         | `bash test/integration/lambda-boot-probe.sh`             |
| Azure GHCR throughput            | `bash test/integration/e2e.sh azure-ghcr-probe --vitest` |

These older entrypoints have their own environment and cleanup contracts; they
are not automatically adapted to the shared dispatch interface. The Lambda boot
failover workflow remains a standing qualification of the production gateway's
recovery behavior. Removing diagnostic launchers does not retire the RFC 0017
test sources or their qualification requirements.

### Execution and evidence

The runner checks the source SHA, validates the experiment path, and passes the
argument array directly to `run.ts` through tsx. `SPIKE_PHASE` is `run` or
`cleanup`; `SPIKE_OUTPUT_DIR` names the shared evidence directory. Write sanitized
reports there. The dispatcher records execution/cleanup exit codes and source/run
identity in `spike-run.json` and `spike-cleanup.json`, preserving failures even
when cleanup succeeds. Before reporting success, a cleanup phase verifies that
every resource type the experiment created is gone.

Each experiment owns bounded provider operations, unique resource ownership,
durable resource tracking, and resumable cleanup. Cleanup receives the same
credential profile and evidence directory. The workflow allows 85 minutes for
execution and 20 for cleanup within a 120-minute job. Cancellation or runner loss
can interrupt any workflow step; provisioning experiments must document how to
resume cleanup from their retained inventory.

Evidence uses the repository's protected `implementation-evidence-*` artifact
class, is uploaded on success or failure, and is retained for 30 days. Link runs
and copy decision-critical evidence into durable storage before expiry. A green
runner records command success; the experiment's assertions and decision report
establish what was actually proved.
