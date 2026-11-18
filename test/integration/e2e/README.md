# Constrained E2E tests

This directory is the only location for new workload E2E specs. Exact
lower-layer protocol and runtime compatibility suites are listed in the closed
`lowerLayerIntegrationTests` ESLint allowlist instead. RFC 0017 defines the E2E
architecture and keeps the migration record.

Repeated behavior is a contract family. A member spec may only select its
filename-implied target and assert the contract completion record:

```ts
import { test, expect } from '../../../fixture.js';

test('AWS satisfies the persistent VM contract', async ({ e2e }) => {
  const result = await e2e.contracts.persistentVm('aws');
  expect(result).toEqual({
    contract: 'persistent-vm',
    qualification: 'conclusive',
    target: 'aws',
    satisfied: true,
  });
});
```

Contract runners own the lifecycle, common assertions, retries, waits,
diagnostics, and cleanup. A family-owned submission stage uses the canonical
product entry point and serializes target placement. Target adapters may only
provide validated profile data, named target faults, and meaningful substrate
observations. They cannot choose the submission transport, skip stages, or
replace the lifecycle. Add a new family rule before adding specs beneath
`specs/contracts/<family>/`.

Contracts and target adapters are closed internal layers as well as typed
interfaces. Their lint boundary uses an explicit dependency allowlist and
rejects Node or package imports, direct transport/mechanic access, re-exports,
dynamic imports, ambient process/network/time capabilities, and inline lint
configuration. Raw execution and provider transports belong outside those
layers and are injected by the fixture composition root. Alternate module
extensions are rejected so the strict E2E TypeScript project cannot be
bypassed.

Persistent-VM lifecycle and host loss compose the same
`provisionRunningPersistentVm()` journey and then take fixed, mutually exclusive
terminal paths. The host-loss adapter adds only `deleteHost(context)` to the
shared running surface; the contract owns the `Failed` transition, event/ledger
assertions, no-replacement proof, and cleanup observation.

Both VM paths register native verification through the existing private
Workload cleanup hook before creation. They retain every validated provisioning
identity, including ended attempts, and bind reads to the original credentials
and placement. A missing inventory, unknown native observation, or inconclusive
termination keeps the cleanup registration and durable manifest. Successful
release requires complete ledger observations and native absence for every known
identity. Teardown uses its own cancellation scope, and failures preserve both
the primary error and cleanup errors.

The cloud VM and Local workflows retain successful and failed evidence
artifacts for 30 days, alongside the existing three-day failure diagnostics.
The retained `e2e-run.json`, fixture outcome, `cleanup-observations.json`, and
`vm-*-native-{identities,cleanup}.json` records expose actual test results and
cleanup registrations; a green workflow alone does not establish a pass.
Native identity records contain validated metadata only, including placement
and the original nonsecret profile row ID. Strict inventory queries suppress
raw process output before validation, and the evidence uploads use existing
contract observations for Local inventory. Lambda and Local VM error
diagnostics omit raw provider bodies. Previously exposed notebook
credentials still need separate revocation or rotation; deleting an artifact
does not perform either action.

For an operator-dispatched cleanup check, select `force_vm_cleanup: true` in
**E2E VM Tests** or **Integration Tests**. The two Vitest VM paths fail immediately
after Running and identity capture, then run their ordinary fallback cleanup.
The equivalent direct flag is `E2E_VM_FORCE_FAILURE_AFTER_RUNNING=1` with the
existing outer runner. Inspect the expected failure, allocated identities,
native observations, and completed registrations in the raw artifacts.
Forced-cleanup cells stay advisory.

To check that VM hosts keep no registry credential, set
`private_ghcr: true` in **E2E VM Tests**. Each persistent VM then runs the
private `ghcr.io/anycloud-sh/ci-private` image, submitted with
`E2E_GH_TOKEN_ORG_PACKAGES` so that the API logs in to GHCR. Before the repair,
the contract checks over SSH that no file under `/root/.docker` or
`/run/anycloud` holds a GHCR login. It then leaves a placeholder GHCR login in
root's Docker config, as earlier releases did, and removes the container
and its image. After the repair pull, it checks again.

For a Lambda-only run in **E2E VM Tests**, set `lambda_only: true`. Normal
mode runs both Lambda VM members and the Lambda cleanup sweep. Combine it with
`force_vm_cleanup: true` to run only the two forced Lambda members and that
sweep. Keep `aws_normal_only` false; mixed selections fail before setup or
provider operations. With `lambda_only` false, the full matrix, AWS normal
selection, and existing sweeps retain their behavior. Inspect the inner outcomes and exact native cleanup records;
the sweep count does not prove release of a named identity.

For an explicitly declared AWS/GCP/Lambda historical Service cohort, the GPU workflow
also accepts a read-only `service_cleanup_audit` JSON manifest with `provider`
set to `aws`, `gcp` or `lambda`. All GPU/Service provisioning, MACE/disk-tier companions and
provider sweeps are excluded in this mode; force-cleanup and MACE-only inputs
must be false. `yarn audit:service-cleanup` is its CI entrypoint. The manifest
contains `version: 1`, `originalSourceSha`, `originalRunId`, and up to five
`scopes`, each naming `provider`, `workloadId`, `originalDnsRecordId`,
`originalProfileRowId` (or explicit null), `hosts`, and `reservations`. Every
location has the original `cloudId`, `region`, and nullable `availabilityZone`;
GCP and Lambda reservations are unsupported. AWS reservation tokens must belong to the
exact original Workload. The hostname is derived from that same Workload ID.

Lambda requires distinct original 32-character lowercase hexadecimal instance
IDs, their original regions, null availability zones, and a non-null
`originalProfileRowId` containing the original typed credential's SHA-256 hash.
Every selected Lambda scope must match the frozen credential before any native
or DNS request. Missing or different credentials fail with retained uncertainty
and no requests; another account cannot discharge the original obligation.

The audit uses the existing native observer and Service DNS probe with frozen
workflow credentials. It takes two observations ten seconds apart under a
120-second per-scope and 300-second total command deadline, without creation,
termination, API-state mutation or release of tracking. Retain the original
credential/placement binding and credential-continuity evidence in the issue;
a replacement account cannot discharge the original obligation. Sanitized,
accumulated snapshots survive later failures and are retained for 30 days under
the protected Service evidence prefix. A current external-absence result does
not reconstruct missing persisted Workload/secret state or rewrite the original
run's result. Unsupported, incomplete and unavailable evidence stays unresolved.

Global failover can leave ended attempts with reserved names and no native
instance ID. The shared Vitest cleanup fixture asks the existing cloud observer
for reservation-presence evidence, separately from native-ID absence receipts.
AWS checks each
immutable ClientToken in its original region through complete paginated
inventories with the same minimum absence interval. Historical tokens retained
after native adoption are reconciled against their original ledger row and
independent native-ID absence; an unledgered match remains unresolved.
Missing pages, changing totals, malformed responses, or matching instances cannot
prove cleanup; every known instance still requires its own native check.

VM-host Service composes the same tracked-Workload kernel through fixed stages:
submission, readiness, and termination. Public-cloud and local-smolvm adapters
return the target's answer and nothing else — a host that cannot be queried is
reported as unknown, which never satisfies absence. Cluster-backed Service is
deferred to RFC 0032 and is not a current target. Environment and named-secret
probe fixtures own the resources whose injection the contract verifies; they
register their own cleanup, and only a digest of the secret leaves the fixture.

The four GPU Service members invoke `e2e.contracts.gpuServe(target)`. The same
owned `ActiveServeBaseline` remains live through `GpuServeEvidence`; only its
single finalizer may terminate and publish completion. Copied or foreign active
records, changed native coordinates, missing device evidence and early or
repeated completion fail. The fixed profiles are AWS `g6e.xlarge` with a 100 GiB
disk, Azure `Standard_NC4as_T4_v3`, GCP `g2-standard-4` in `us-east4` with NVIDIA
runtime, and Lambda `gpu_1x_a10` using the existing qualified A10/24.04 resolver.
AWS, Azure and Lambda placement stays unpinned. All use `python:3.12-slim`,
`--gpus all`, successful enumeration before server startup, env-file/direct-flag
precedence and named-secret digests. Run a member with
`bash test/integration/e2e.sh aws-gpu-serve --vitest` or its
`yarn test:aws-gpu-serve:vitest` alias; substitute `azure`, `gcp` or `lambda`.

Service cleanup uses the existing native cleanup owner with the selected
Service profile, registered before creation. Normal and fallback release
require persisted terminal cleanup, a cleared VM ledger, every historical
native identity absent, authoritative DNS absence for public Services (closed
tracked ports for Local), and exact named-bundle deletion readback. Cancellation
of the test cannot cancel teardown. Unknown observations retain the Workload
manifest and named-resource obligations. The six existing Service members use
the same proof path; Local recovery and AWS upgrade retain their journey order.

Select the default-off `force_service_cleanup` input in **E2E GPU Qualification**,
**E2E Serve Tests** or **Integration Tests** for the bounded cleanup check. Only
Service jobs receive `E2E_SERVE_FORCE_FAILURE_BEFORE_FINALIZE=1`. The
fixture records all required journey evidence, then throws immediately before
normal finalization. GPU MACE/disk-tier, hosted-API companions and provider
sweeps remain mandatory under their existing locks and budgets.

The protected `service-comparison-evidence-*` artifacts retain compact normal
and failure records for 30 days: source revision, `e2e-run.json`, fixture record,
cleanup registrations, native identities/observations, Service boundary/DNS/
named-bundle receipts and GPU evidence. Inspect the inner spec outcome and
raw cleanup records; a green workflow alone proves nothing. The outer API
cleanup backstop cannot clear a Service member's retained
native-verification manifest.

The shared native-host observer validates complete provider responses against
the original instance identity, placement, and credential. Authentication and
schema failures are errors; an unavailable read is unknown. Azure/GCP probes
use separate private CLI sessions. Authentication, requests, and response bodies
share the remaining wait deadline, and native HTTP reads reject redirects.
Artifacts retain validated identity/state metadata, never raw provider bodies
or authentication output.

Job cleanup also has the observer read each absent VM's boot disk and keeps the
VM present until that disk is gone too: AWS volumes tagged with the Workload,
Azure `<vm>_OsDisk_*` disks in its resource group, and the GCP disk named after
the VM. A Lambda instance has no separate disk.

An extension never consumes final completion while its resource must remain
live. Service and dedicated-Job journeys return a typed active-baseline record,
then zero or more required extension records, then one finalizer owns terminal
observation, persisted cleanup, independent substrate absence, ref release, and
the single completion record. Recovery faults require typed pre-fault evidence
and produce typed post-fault evidence; neither may be reconstructed from logs.

The `spot-eviction` Job members (`<target>-spot-eviction` for AWS, Azure and
GCP, dispatch-only in `e2e-job.yml`) run an unpinned spot Job that writes a
24 GiB output and exits 0. Once the Job is `finalizing`, the family evicts its
VM natively, using the same fault as the bucket-sync members' running-Job
eviction. It then requires the `final-bucket-sync-vm-restarted` event, a new VM
row on the same `cloud_id`, `completed` with exit code 0, and the full output in
the bucket. If the final sync finishes before the eviction lands, the run fails
as inconclusive; it never passes. Lambda has no spot instances, and Local
smolvm has no spot or preemption seam.

The `azure-gpu-spot-eviction` member evicts a running
`Standard_NC4as_T4_v3` spot Job on the MACE image. Each start of the Job runs
`nvidia-smi -L`, reads `torch.cuda.mem_get_info()` and checks a CUDA sum against
its known value. The first start writes its result to the checkpoint and waits
for the eviction. A start that finds that checkpoint writes its result to the
output and exits 0. The member requires a recovery event, a new VM row,
`completed` and that output, on the restarted VM or on a fresh one. Its
`-gpu-eviction` artifact records which, with the events after the eviction and
the matching log lines.

The `gpu-probe-rerun` Job members (`<target>-gpu-probe-rerun` for AWS
`g4dn.xlarge`, Azure `Standard_NC4as_T4_v3`, GCP `g2-standard-4` and Lambda
`gpu_1x_a10`, dispatch-only in `e2e-job.yml`) check the VM-host GPU
probe. A `--gpus` Job on `python:3.12-slim` prints `No CUDA GPUs are
available` and exits 1 on a healthy GPU. It must rerun once in place
(one Retrying with `gpu-rerun-in-place` and a probe listing `GPU 0:` that
ends `exit=0`), retry nothing else, end Errored with the "passed a CUDA check
on its VM twice" message, and keep every attempt on one VM. Each cloud runs
its own host image, which is what the probe reads. The probe-fail path needs
a faulty GPU, so it isn't covered.

The `storage-tokens` family (`<target>-storage-tokens` for AWS, GCP and Azure,
dispatch-only in `e2e-job.yml`, run per release from `RELEASE.md`) checks
the storage-tokens minting endpoint against the harness's API with the CI key credential,
on two fresh buckets and no VM. One request mints `read-a/` and `read-b/` read
and `rw/` readwrite (one token on AWS and GCP, three on Azure), and each
token's expiry must match its cloud: AWS's 15-minute floor, a GCP key's hour,
Azure's exact 5 minutes. With the cloud's own SDK and only the minted tokens,
both read prefixes read back the CI credential's bytes, `read-a/` lists, and
`rw/` takes a small and a multipart object that read back exactly. The cloud
must then refuse reads, writes and listings outside the grants, in a sibling
`rw-x/`, and in the second bucket, and deletes under `read-a/`, `out/` and, on
AWS and Azure, `rw/`; each refused delete leaves the object intact. A GCP
readwrite token's delete inside `rw/` is allowed, as the owner accepted, and
recorded. These refusals must all finish a minute before the first token
expires, since an expired token is refused too. The API must answer an
escaping prefix and eleven grants with 400. Last, on AWS and Azure, a read the
tokens allowed is refused once they expire. A GCP key's token can't be shorter
than an hour, so GCP's expiry is checked by `role-storage-tokens`, whose role
token lasts its 10-minute floor. The family
deletes both buckets and proves them gone. Role connections are checked by
`hosted_stage`'s `live_checks=role-storage-tokens`.

To run only some **E2E Job Tests** members, set the `tests` input to their
names, separated by commas or spaces. Unselected members succeed without
touching a cloud, an unknown name fails the run, and the provider cleanup jobs
still run. For example:

```bash
gh workflow run e2e-job.yml --ref main \
  -f tests=aws-spot-eviction,azure-spot-eviction,gcp-spot-eviction
```

Direct specs are reserved for genuinely unique scenarios. The repository
rejects imports other than the correctly relative public fixture, suites,
hooks, direct globals, timers, networking, process access, mocks, dynamic
imports, lint suppressions, custom test timeouts, and top-level helpers. It also
rejects newly named integration tests outside `e2e/specs`; the old files in the
ESLint grandfather list may only be removed from that list as they migrate.

The [repository policy](../../../CONTRIBUTING.md#repository-policy) defines
entrypoint ownership, mandatory execution, and the limits of static checks.
Workflow and package declarations use literal, owned entrypoints. Helpers are
libraries except for the existing executable utilities; temporary provider
proofs belong in documented, type-checked experiments. Fixture lint coverage,
runner discovery, and runtime assertion requirements remain enforced.

In the Job workflow, the runner supplies AWS, Azure, and Google Cloud CLIs; `ci/check-cloud-tools.sh` checks that baseline before cloud
tests. Provider fixtures supply identity and checkpoint configuration.
Diagnostic logs retain their three-day window.

The stress harness requires at least 300 overlay jobs and one second-caller
witness so the fairness assertion can distinguish a fair scheduler from FIFO.
Its memory and seeded-database assertions are mandatory. Smaller fixtures fail
before setup; both workflow defaults and the Local CI lane select 300 jobs.

Use the fixture capabilities instead:

| Need                                                            | Capability                                       |
| --------------------------------------------------------------- | ------------------------------------------------ |
| Run a shared provider contract                                  | `e2e.contracts`                                  |
| Run the built CLI                                               | `e2e.cli.run(argv)`                              |
| Retry a transient submit                                        | `e2e.cli.runWithTransientRetries(argv)`          |
| Call a named authenticated API operation                        | `e2e.api`                                        |
| Create scoped collision-resistant names                         | `e2e.names.workload/secret(prefix)`              |
| Create a bounded command shim                                   | `e2e.files.commandShim(...)`                     |
| Read a tracked direct spec's live VM fact                       | `e2e.workloadFacts.liveVmCount(id)`              |
| Prove preflight created no records                              | `e2e.workloadFacts.provisioningRecordCounts(id)` |
| Verify hosted authorization and durable account identity        | `e2e.apiAuth.accessPolicy()`                     |
| Verify secret CRUD and response privacy                         | `e2e.apiAuth.secretCrudPrivacy()`                |
| Verify a no-grant credential is refused as BUCKET_ACCESS_DENIED | `e2e.bucketAccess.denied(provider)`              |

Contract-only mechanics such as waits, target profiles, VM access, secrets,
hashing, and artifact writing remain private to fixture internals. Expose a new
direct-spec capability only with its first concrete direct consumer.

The VM-hosted API update and recursion members were removed with `api serve`.
The cluster-hosted API journey in `e2e-cluster-cloud` replaces their operator,
release and recursive Job coverage. See their rows in [the retirement table](./RETIREMENT.md#members).

`hosted-api-access-policy` and `secret-crud-privacy` each own an isolated shipped
API process, private database, cipher key, and callers. They create no external
resources, assert zero native VM records, stop their processes, and record native
cleanup as `Not applicable`. This classification applies to each concrete member.

The routing members' per-requirement coverage lives in their assertion maps
under `qualification/assertion-maps/`; their retirement state is in
[`RETIREMENT.md`](RETIREMENT.md).
The retained API-image and API-startup shells still own Docker/process launch;
their typed helpers own parsing, polling, privacy, and assertions, including the
existing SSH pressure and ordered shutdown checks. Their individually declared
forced-cleanup execution selects
`E2E_API_PROCESS_FORCE_FAILURE_AFTER_RUNNING=1`. After the launcher exits, run
`yarn -s tsx test/integration/helpers/api-process.ts verify-cleanup "$RESULTS_DIR" <api-image|api-startup> <success|failure> <normal|forced>`.
Verification requires the declared phase outcome, complete exact-identity native
absence, and successful final cleanup. It also rechecks absence before writing
`api-process-cleanup.json`; missing or failed evidence remains red. Raw phases
are retained in `api-process-observations.jsonl`.

The Integration workflow's default-off `force_api_process_cleanup` input forwards
that injection only to `api-image` and `api-startup`. Their normal failures remain
blocking. An injected run can continue to the strict verifier, which must observe
the named failure, every owned container's absence, and successful launcher
cleanup. Always-running metadata and uploads retain the raw process observations
and final verification even when the test fails.

A Vitest cell's evidence is the spec result itself (`✓ <member> (vitest)
passed`). No post-step re-validates a passing member, so a green execution is a
green job. Failure diagnostics are still uploaded for three days.

Stages and contracts take every workload ID and resource name from `names`
(`internal/names.ts`), never a hand-built template: workload IDs must fit the
product's 28-character limit.

Resource-producing CLI calls require an explicit workload ID. The automatic
fixture reserves that identity and arms fallback cleanup before it invokes the
CLI. Contract families use the private tracked-workload kernel directly:
submission, upgrade, resubmit, and termination transports require its opaque
reference and validate the outgoing ID. Only a persisted-cleanup proof can
release fallback cleanup. Named resources such as secrets retain independent
LIFO cleanup registrations.

Use the API request, response, credential, workload-state, and SSH types from
the owning oRPC contract when one exists, otherwise from the named owner under
`src/shared/`, inside fixture internals. Keep only fixture observations and
sanitized command results in `internal/types.ts`; do not copy wire types or
introduce a second response schema in the E2E tree.

Run a local member directly when it owns its own prerequisites:

```sh
yarn test:cli-exit:vitest
```

Run API-backed or cloud members through the isolated outer runner:

```sh
./test/integration/e2e.sh image-preflight-invalid --vitest
./test/integration/e2e.sh aws-vm --vitest
./test/integration/e2e.sh azure-vm --vitest
./test/integration/e2e.sh gcp-vm --vitest
./test/integration/e2e.sh lambda-vm --vitest
./test/integration/e2e.sh local-smolvm-vm --vitest
./test/integration/e2e.sh aws-vm-host-loss --vitest
./test/integration/e2e.sh azure-vm-host-loss --vitest
./test/integration/e2e.sh gcp-vm-host-loss --vitest
./test/integration/e2e.sh lambda-vm-host-loss --vitest
./test/integration/e2e.sh local-smolvm-vm-host-loss --vitest
./test/integration/e2e.sh aws-serve --vitest
./test/integration/e2e.sh aws-serve-upgrade --vitest
./test/integration/e2e.sh azure-serve --vitest
./test/integration/e2e.sh gcp-serve --vitest
./test/integration/e2e.sh lambda-serve --vitest
```

### Local cluster member (`e2e-cluster-local`)

```sh
yarn test:e2e-cluster-local:vitest
```

`specs/e2e-cluster-local.spec.ts` drives the API's cluster record and its
Helm-managed release against a real Kubernetes on the runner's Docker (the k3d
pattern). It needs Docker and the pinned K3s image:

1. `substrates/local-cluster/cluster-host.ts` starts one K3s server container and
   publishes its kubeconfig on the Docker host-gateway address; the fixture
   mints a token connection for a ServiceAccount bound to a copy of the
   chart's rendered `anycloud-api` ClusterRole, not `cluster-admin`, and the
   API child (`substrates/local-cluster/api-child.ts`) records it as the
   installation's cluster before serving, with the `kube-system` identity the
   fixture observed itself.
2. The API child is hard-replaced on the same state root; the relaunched API
   still lists the cluster Running under its identity
   (`environment.ts` `replaceController`, `clusterIntact`).
3. A Helm-managed API built from this tree, installed with an older inline
   chart, switches to its own OCI chart once and is not restarted
   (`substrates/local-cluster/hosted-chart.ts`).

### Cloud cluster member (`e2e-cluster-cloud`)

`./test/integration/e2e.sh e2e-cluster-cloud --vitest` — the real-cloud sibling,
dispatch-only (`e2e-cluster-cloud.yml`). `substrates/cloud-cluster/environment.ts` holds
every `cluster` CLI verb, the reads of the installation's managed checkpoint
bucket and the native sweep (EC2 and S3 for an AWS
management VM; for a GCP or Azure one, its VM and network by its
`anycloud-cluster-<id>` scope and its checkpoint buckets through the
product's storage gateway, written as `cluster-native-sweep`);
`contracts/cluster-cloud.ts` bootstraps a
cluster on the management VM's cloud (this tree's `cluster create` runs in the
CLI process on the cluster credential as its cloud session: AWS keys, a GCP
service-account key file it writes for Application Default Credentials, or an
Azure service principal in `AZURE_*`), and every journey then drives the
hosted API on the cluster, since no local API holds it. The default journey
runs the `api use`, `credentials new` and `api access` walk, then deletes the
cluster and sweeps by the product's tags.
`cluster delete` keeps the managed checkpoint bucket after a final backup
(RFC 0049 C28): on the default journey the harness checks it, then removes it
through the product's storage gateway, since deleting a kept bucket later is
the unreachable delete path's; the hosted journey deletes it
with `cluster delete <id> --delete-buckets --confirm <id>`. Cleanup removes
any bucket a failed run's delete kept.
`restore_stage` restores the default journey's cluster from that kept bucket
instead (`cluster create --checkpoint-bucket <id>`, same id and hostname),
then deletes it with the bucket. `dead_api_delete` deletes it as from a second
machine: the runner's cloud CLI stops the management VM, and once the hosted
API no longer answers its health route, the CLI in a fresh home runs
`cluster delete <id> --cloud <c> --region <r>` (plans only), then with
`--delete-vms`, `--delete-buckets` and `--skip-cloud`, each with
`--confirm <id>`; a failure past the stop leaves cleanup to delete the VMs and
buckets the same way.
Runs are concurrent: each stamps its own version (`0.0.<run id>`), so its API,
chart and receiver tags are its own, and the fixture records the installation
id `cluster create` prints first, even when create then fails or runs out of
time. The workflow's sweeps then touch only
that record's ids; without a record, only ids older than the longest job
(`ci/cleanup/e2e-cluster-stale-ids.ts`), never a live run's.
With `hosted_stage` (an AWS cluster) the `api access` walk, a VM Service
through the hosted API, `api upgrade` both ways (after each the Service still
runs, `cluster list` shows the API's cluster `running` and the saved
credential decrypts) and the recursive VM Jobs run too. The Service and Jobs
are `vm_type` VMs (`E2E_CLUSTER_VM_TYPE`, `t3.small` by default) on the
cluster's credential and in its region, so the native sweep covers them by the
hosted API's `anycloud_owner_api` tag.
With `from_release` (for example `0.1.66`) that release's CLI starts the
installer on the published image (`e2e.sh` pulls it first, since other e2e
builds on the runner's Docker host tag this tree as `api:<package version>`),
saves the credential, creates the cluster, waits until that installer lists
it up (from 0.1.66 `cluster create` returns at once, and restarting the
installer mid-creation orphans it) and runs `api use`, `credentials new` and
the VM Service against its hosted API; this tree's `api upgrade`, with the installer's local
API active, then restarts the installer on this tree, and a later `api upgrade`
against the hosted API alone upgrades it without `--image`, and the Service
must still run and the credential decrypt before the stage continues.
A release older than `Upgrade N` (0.1.65) answers the upgrade request in a
shape this CLI prints as accepted; the stage counts it as started once the API
that served the release serves this tree's version and its status names the
upgrade.
Until this tree's `api upgrade` moves the installer, cleanup deletes the
cluster with the released CLI, since the released installer refuses this one;
the released CLI waits up to five minutes for its creation to settle, and not
at all if bootstrap already timed out waiting for it (the workflow's sweep then
removes what it made). After the upgrade this tree's CLI has no create ledger
for a cluster a released installer made, so it deletes it through the hosted
API's record, with the released CLI as the fallback. This tree's own create
runs to its end in its CLI process, so cleanup deletes a failed or cut-short
create from the runner's create ledger at once, and a create that failed
before recording one leaves nothing to delete. A delete that a hosted API
still on the release refuses waits, within five minutes, for its accepted
upgrade to serve this tree's version.
The run stamps `<major>.<minor>.<run id>` instead of `0.0.<run id>`, since
the API refuses an image older than its database.
`live_checks` (`E2E_CLUSTER_LIVE_CHECKS`, empty by default) adds checks to
`hosted_stage`, after the operator walk:

- `role-apply` (`hosted_stage`): for AWS, GCP and Azure,
  `credentials new --role --apply --json` against the hosted API through the
  runner's signed-in `aws`, `gcloud` and `az`. It applies again to prove the
  result is the same, checks each cloud's CLI finds the setup, then runs
  `credentials delete --apply --json` and checks it's gone. GCP uses the run's
  own `ANYCLOUD_ROLE_*` IDs, since GCP keeps deleted ones for 30 days. The
  workflow's role-apply sweep, which also runs under `sweep_only`, removes
  `anycloud-role-e2e-*` stacks, `e2e-r*` GCP resources and an e2e-trusting
  Azure `anycloud-role` group; one such run goes at a time. The record is
  `role-apply-check`.
  The role-connection checks (RFC 0047 S14 to S17) run on `hosted_stage`
  (`contracts/role-connections.ts`,
  `substrates/cloud-cluster/role-*.ts`). One API covers all three clouds, since
  the exchange goes from the API through its public issuer. Each check deploys
  each cloud's trust from the setup template the hosted API serves, using the
  run's CI credentials: a CloudFormation stack, the GCP script with its pool,
  provider and service account named `e2e-role-<ms>-<rand>`, and an ARM
  subscription deployment into a resource group of that name. It deletes each
  trust again and proves it gone: the stack's role and OIDC provider answer
  `NoSuchEntity`; the GCP binding, service account, provider and pool are gone
  or `DELETED` (GCP keeps the IDs for 30 days, so none is reused); the Azure
  role assignment and resource group are gone. The runner's own exchanges use
  ServiceAccount tokens minted over the installer's connection and no
  credential, so every refusal is the cloud's.

- `role-connections` (S14, S15): the installer's local API refuses a role
  connection. On each cloud the hosted API saves one, which lists only its
  identifiers. The cloud refuses the probe ServiceAccount's token and the
  API's token for another audience. A VM Job writes its output through the
  connection (`--output-storage-credentials`), and the object reads back.
  Each wrong trust is then refused at save: AWS at 1 h `MaxSessionDuration`,
  and a wrong audience or subject.
- `role-trust-pinning` (S17): each unpinned trust is refused at save, naming
  the subject or audience. On AWS that is a `StringLike` subject, no `aud`
  with the probe audience added to the provider, or the issuer only. On GCP it
  is no subject condition with a `principalSet://…/*` binding, or the probe
  audience allowed. On Azure, which has no wildcard, it is a second federated
  credential for the probe's subject or audience; one ARM refuses is recorded
  as not applicable.
- `role-key-rotation` (S16, last in the journey): both keys exchange during
  the overlap. A retire before the overlap's end is refused without
  `--skip-overlap`. After it, AWS and Azure must refuse the old key, and GCP's
  refusal is recorded (`E2E_ROLE_GCP_RETIRE=assert` asserts it). Each trust is
  then recreated from its template, GCP on a new provider ID, and saved again.
  It must refuse a token the retired key signed for it.

`cluster_provider` (`E2E_CLUSTER_PROVIDER`: `aws` by default, `gcp`, `azure`)
chooses the management VM's cloud: the credential `cluster create` uses, its
region and VM type (`substrates/cloud-cluster/configuration.ts`: `us-east-2` /
`t3.medium`, `us-central1` / `e2-standard-2`, `westus2` / `Standard_D2s_v5`).
A GCP or Azure management VM runs only the default journey (`hosted_stage` is
refused up front until it is qualified there), and its cluster-side reads and
sweeps are per provider. The workflow's own sweeps then cover it from a fresh
process: on GCP the management VM and its firewall rule by
`anycloud-cluster-<id>` (every `anycloud-cluster-e2e-clust-*` when a failed
create left no id) and `e2e-clust-` GCS buckets; on Azure the installation's
resource group and `e2e-clust-` containers of the shared storage account.

The local cluster member is born Vitest: its Integration cell is required from
the first run and it is listed under "Born-Vitest members" in
[`RETIREMENT.md`](RETIREMENT.md). Cleanup is the same LIFO stack as every
constrained member: the API child and the K3s server container are released
in reverse order with redacted evidence records.

These are the only sanctioned entry points. The default Vitest configuration
excludes the constrained specs, so watch mode and editor gutters cannot start a
constrained member, and the fixture refuses to provision without the marker
`vitest.e2e.config.mts` supplies. `yarn check:boundaries` proves the exclusion
and `yarn test` proves the marker guard.

CI runs each member in a fresh job and uploads separately named artifacts.

Both runner paths install the same evidence trap before member resolution.
Normal runs and setup failures therefore emit one write-once `e2e-run.json`, a
compatibility `joblog.txt`, the declared log, and triage output. Debug mode may
retain resources, but it does not bypass evidence validation.
Every Bash member retired on a green streak; [`RETIREMENT.md`](RETIREMENT.md)
is the frozen record. `yarn check:rfc-ledgers` still closes RFC 0017's
legacy-source disposition table over the root shell-source registry.

Each finalized fixture also writes
`vitest-fixture/<test>-<run>/fixture-record.json` holding its outcome, the
errors the test threw, every workload it tracked with the status observed
during teardown, and the artifacts capturing that workload's verbose status
and Docker state. Triage reads those records, so `START_HERE.md` names tracked
workloads even when no API log line ever mentioned them and reports the
fixture's own failure as the root cause. A failed run with no record failed
before any fixture started; a directory without one belongs to a lifecycle that
never finished. A malformed record fails triage.

Managed GPU qualification records completed CUDA executions separately from
intermediate retry/recovery attempts and links each required phase to its
observed identities. Its receipt gate checks serialized evidence, candidate
artifact bytes, physical GPU allocation, and tracked cleanup. Retries require
the original candidate artifact and confirmed cleanup for every earlier
attempt. Missing artifacts are never rebuilt; missing cleanup proof blocks
automatic continuation.
