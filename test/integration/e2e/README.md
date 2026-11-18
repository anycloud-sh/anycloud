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
deletes both buckets and proves them gone. Role connections and a registered
Deployment's Pod-bound token are checked by `hosted_stage`'s
`live_checks=role-storage-tokens`.

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

The independent-Cluster managed-Kubernetes composition (Cluster → Deployment →
targeted Job) and the control-plane host-recovery proof retired on 2026-09-25
with the independent Cluster surface (owner decision C, 0.1.65). Their per-PR
real-API-on-real-Kubernetes coverage continues as the **local cluster** member
(`yarn test:e2e-cluster-local:vitest`).

### Local cluster member (`e2e-cluster-local`)

```sh
yarn test:e2e-cluster-local:vitest
```

`specs/e2e-cluster-local.spec.ts` drives today's merged cluster and node-pool surface
against a real Kubernetes on the runner's Docker (the k3d pattern). It needs
Docker, the pinned K3s image and `E2E_PRIVATE_REPO_TOKEN`, a token that reads
the private `anycloud-sh/private-fixture` repository. Without access, set
`E2E_PRIVATE_REPO_SKIP=1` to skip the private-clone check:

1. `substrates/local-cluster/cluster-host.ts` starts one K3s server container and
   publishes its kubeconfig on the Docker host-gateway address, so the API on
   the host and agent containers reach one URL; the fixture mints a token
   connection for a ServiceAccount bound to a copy of the chart's rendered
   `anycloud-api` ClusterRole, not `cluster-admin`, so every RBAC verb the
   hosted API needs is exercised on each run, and the API child records it as
   the installation's cluster before serving, with the `kube-system` identity
   the fixture observed itself.
2. `anycloud node-pool create` runs against an API child
   (`substrates/local-cluster/api-child.ts`) with two injected seams. The
   first is node pool VM compute (`composition.ts` `nodePoolCapacity`): "provisioning a VM"
   starts a privileged `k3s agent` container from the exact production join
   configuration — the cluster endpoint, CA-pinned bootstrap token, Node name,
   labels and taints the node pool controller issued for that attempt
   (`capacity-compute.ts`). Two node pools prove isolation and capacity
   replacement. The second is image inspection (`inspectDeploymentImage`):
   the local images are in no registry, so it serves the workload image's
   digest, Entrypoint and Cmd from the pool-Job stage's `workload-image.json`,
   which pool-Job admission needs.
3. `deployment create --node-pool` produces a handler Pod; Jobs flow through
   `current_deployment().next_job()` in the workspace-built Python SDK to
   completion, including admission, concurrency, lost-reply recovery, rollout
   and drain, and runtime loss (`contracts/deployment.ts`,
   `contracts/targeted-job.ts`).
4. `anycloud job IMAGE --node-pool` runs two
   Jobs through the runner on one managed Deployment, which scales from zero
   and back to no Pods. `preparePoolJobImages` builds the API image as the
   runner image and imports it, with the workload image, into the pool's
   Nodes (`contracts/cluster-local.ts` `qualifyPoolJobs`). On the one-Node
   pool, a pair sized to share one replica proves the Job logs: a `logs -f`
   attached while the first runs ends with it and shows none of the next
   Job's lines, and the next Job's stored tail holds only its own
   (`qualifyPoolJobLogs`). A second pair there proves the reset between Jobs: each requests over half
   the Node's free CPU, so one replica runs both, and the workload image sets
   `WORKDIR /app` so the working directory is restored (`qualifyReset`,
   0044/S19). Four more prove the replica options (`qualifyPoolJobOptions`): `--ipc host` and `--shm-size` size `/dev/shm`, and a Job with
   `--secret` holding `E2E_PRIVATE_REPO_TOKEN` clones the private fixture
   repository while the same Job
   without it fails to authenticate. Each runs on its own managed
   Deployment. Fork and Dependabot pull requests get no secrets, so they
   skip that pair.
5. `anycloud service --node-pool` reaches Running as Pods (no VM row) and its
   deletion removes the Service-owned namespace (`contracts/cluster-local.ts`
   `qualifyNodePoolService`).
6. The API child is hard-replaced mid-flight; the cluster connection revision,
   node pool VM ledger and the running Job are reconstructed from durable
   state (`environment.ts` `replaceController`).
7. Node pool deletion is fenced by live Deployments, then removes every Node
   and agent container while the cluster stays Ready under its identity
   (`environment.ts` `clusterIntact`).

### Claim burst member (`e2e-claim-burst-local`)

```sh
yarn test:e2e-claim-burst-local:vitest
```

`specs/e2e-claim-burst-local.spec.ts` is S12 (RFC 0044 decision 26),
run by `e2e-claim-burst.yml` nightly, on dispatch, and on pull requests that
touch the claim path:
the claim queue under load, on the local cluster's substrate with its
management node held to a production default's 2 vCPU and 4 GiB (CPUs 0
and 1, which the API child shares through `taskset`). It reads the API
child's own load (`substrates/local-cluster/api-load.ts`): CPU, event-loop
delay, a one-row query's wait on SQLite's operation queue, and each runner
route's latency and server errors.

1. **Burst** on a two-Node pool of a priced VM type: 20 human Jobs first,
   whose replicas price a slot, then a whole-dollar per-session throttle
   that holds one Job, and 1,000 Jobs, one in five in each of two agent
   sessions, each sized so 20 replicas fit the Nodes. A claimed Job waits
   until all are admitted, so none ends during admission and the queue
   outgrows the in-flight cap however slowly they are submitted. Every Job
   completes after one attempt whose command reports one run; the managed
   Deployment asks for exactly the in-flight cap; no session claim takes the
   session's open slots to its throttle, each session's Jobs wait with the
   throttle's reason while replicas take others, and no human Job does; the
   Deployment returns to zero.
2. **Cap** on KWOK: a pool of KWOK Nodes (`substrates/local-cluster/kwok.ts`)
   whose Pods run no containers. At each level (today's cap, then 500, set
   through `ANYCLOUD_E2E_IN_FLIGHT_CAP`), twice that many Jobs make that many
   managed replicas, each claiming through the production runner loop
   (`runRunner`) with a token bound to its Pod. Every Job must run exactly
   once, after one attempt. A level is green when all its Jobs end within 5
   minutes, the managed Deployment asks for exactly the level, every replica
   holds a Job at once, no runner call fails with a server error and the
   management node doesn't restart; the verdict and the latencies are
   recorded in the `e2e-claim-burst-local-contract` artifact for the owner.

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
runs the `api use`, `credentials new` and `api access` walk, creates one node
pool, runs a Service on it, checks that `cluster delete` is refused while the
pool exists, deletes the Service and the pool, then deletes the cluster and
sweeps by the product's tags.
`cluster delete` keeps the managed checkpoint bucket after a final backup
(RFC 0049 C28): on the default journey the harness checks it, then removes it
through the product's storage gateway, since deleting a kept bucket later is
the unreachable delete path's; the hosted and GPU journeys delete it
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
With `hosted_stage` the pool, Service, `api access` walk, Jobs on the pool
(a Deployment of the pushed receiver completes one Job and acknowledges the
other's cancellation), a Deployment with a named Secret (its replica logs the
value's digest, then a rotated value's and none once the key is removed, each
after `deployment upgrade --secret`; the status never shows the value and an
in-use delete is refused), `api upgrade` both ways (after each the Service still
runs, `cluster list` shows the API's cluster `running` and the saved
credential decrypts) and the recursive Jobs run too.
The pool may be on AWS, Azure, GCP or Lambda (`pool_provider`). A Lambda pool starts
with two 1-GPU VMs from the Lambda GPU list, as every workload takes a Node's GPU
and the Service runs beside one Deployment, which takes the GPU.
Without `from_release`, this journey and `gpu_pool` with one replica then scale
the pool (RFC 0048): a burst of whole-Node Jobs needs two new Nodes (one in
`gpu_pool`) under a `--max-vms` one higher, and must buy exactly those. One Job
outlives the idle window, so its busy Node stays while the others go; no Job is
retried, and scale-in keeps the instances from before the burst. A spot pool
Job's managed checkpoint lives in Azure, so the Azure sweep step deletes the
run's leftovers. The recursive Jobs run
on an AWS pool only, since no native sweep covers VM Jobs on the others. On any
pool, the receiver logs one `EGRESS_PROBE` line before its first Job. It records
the Node's resolvers, resolves the workload API host through them, and records
that the metadata HTTP port is refused under K5's egress policy. On GCP the
resolver must be the metadata server itself, which makes the deny conclusive.
If the pool isn't AWS, the saved cluster credential lists the backups.
With `from_release` (for example `0.1.66`) that release's CLI starts the
installer on the published image (`e2e.sh` pulls it first, since other e2e
builds on the runner's Docker host tag this tree as `api:<package version>`),
saves the credentials, creates the cluster, waits until that installer lists
it up (from 0.1.66 `cluster create` returns at once, and restarting the
installer mid-creation orphans it) and runs `api use` and `credentials new`
against its hosted API; this tree's `api upgrade`, with the installer's local
API active, then restarts the installer on this tree, and a later `api upgrade`
against the hosted API alone upgrades it without `--image`, and the credential must still decrypt before the stage continues.
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
The upgraded API must then read Pod logs: `anycloud logs` for the Deployment
fails at once if its ServiceAccount lacks the chart's `get pods/log` grant.
The run stamps `<major>.<minor>.<run id>` instead of `0.0.<run id>`, since
the API refuses an image older than its database.
With `gpu_pool` a g4dn.xlarge pool goes through the hosted API: it is ready
only once its Node advertises the catalog's `nvidia.com/gpu` count; a Service
on it starts only once `nvidia-smi -L` lists a GPU and serves that list through
its URL; the receiver is built on the cached-model MACE image, loads MACE onto
CUDA once, and runs each Job only after `nvidia-smi -L` lists the device, then
fails it unless a fresh CUDA energy matches the CPU reference baked into the
image (the harness selects that profile, and a GPU receiver without it errors
every Job); a canary Job is checked against its reference plus 1 eV, so it
must error with the energy it computed, which the harness reads back from
the Job's status and requires to equal the CPU reference on a named CUDA
device; and after its instance is terminated natively the kept Deployment
completes one more such Job on the replacement VM. With `gpu_workload: voice`
the receiver builds on `test/docker/Dockerfile.voice` instead (Kyutai TTS 1.6B,
built on the runner from pinned sources, with a CPU reference that Whisper
must hear as its text) and the Deployment admits two Jobs at once: each Job is
one voice session from the one warm model, which renders and checks a warm-up
session before it asks for Jobs; a complete session and a canary must match
the reference (the canary errors with its checked distance, device and
model-load ID, which the harness reads); of three held sessions two run while
the third stays queued for a minute, cancelling one lets the third start while
the other keeps running (a held session that stops producing audio is errored
by the receiver); a second canary, checked beside a held session, must match
too and come from the first canary's model load; and the Job after host loss is
a checked voice session. The receiver image builds while the GPU pool boots. The run holds the
`e2e-gpu-qualification-aws` quota lock. With `pool_provider: azure` the same
journey runs on a Standard_NC4as_T4_v3 in westus2 under the
`e2e-gpu-qualification-azure` lock; Azure deletes the lost VM's OS disk with
it. With `pool_provider: gcp` it runs on a g2-standard-4 (one L4) in us-east4
under the `e2e-gpu-qualification-gcp` lock, without the scale stage and
without `from_release`: the GCP project's GPU quota is one, and the burst or
the upgrade's surge Node would be a second (the record's `scaleSkipped` says
so).

Every one-replica `gpu_pool` run records the time to first inference, with no bound on
any of it. `records.gpu.coldStart` has the first Node and the host-loss
replacement, each with:

- the VM's launch (null on Lambda, whose API has none);
- the Node's creation and Ready times;
- the device plugin's start, which is when `nvidia.com/gpu` becomes
  allocatable (Kubernetes keeps no time for that);
- the receiver Pod's PodScheduled time and its container's start;
- its image's kubelet `Pulled` event as `imagePull`, which is null once the
  Event expires and is not one of the timed points;
- the receiver's `AC_TIMING` marks, and the duration between each
  consecutive pair.

The replacement's Pod waits for its Node, so its record is a cold start with
a `total`. The first Node's Pod points follow the journey's Service and
storage stages, so its record has no `total` and no
`gpu_plugin_started->pod_scheduled`. Each canary Job, submitted once the
receiver is warm, records its creation to its claim as `claimMs`; the voice
canaries also carry `firstChunkMs` and `rtf`. Off a GPU,
`records.hosted.poolJobs.claimMs` is the completed Job's. A missing time or mark
fails the stage. With `agent-restart`, the first Node's Ready and device plugin
times are from its reboot.

On Azure a Job with `--node-pool` and an input, an output and a checkpoint
bucket (RFC 0043 S1 and S6) checks its staged input, copies it to its output
and checkpoint, and fails if a storage credential (a SAS signature, an account
key, an STS session key or a Google access token) is in its env, its files or a
mounted Secret; the harness then finds none in the Job's log or the node pool
namespace's Secrets, and the copies only under `<bucket>/<job-id>/`. With
`hosted_stage` the release journey runs the same Job after its Service: on an
AWS or GCP pool on S3 or GCS, signed by the pool's own credential (S17), and on
a Lambda pool with its input on GCS, its output on S3 and its checkpoint in
Azure, each role naming the run's credential for that cloud with
`--<role>-storage-credentials` (S20). With `pool_spot` the Job has no
`--checkpoint-bucket` (S13 on Azure, S21 on S3 and GCS with `hosted_stage`,
S16 on AWS with the Azure credential and `gpu_pool`): once `status` lists its
managed bucket with an upload, the harness deletes its Pod, the retry must
restore the checkpoint to complete, and the bucket is gone once the Job is
cleaned up. The hosted API creates the
`e2e-clust-in-`/`e2e-clust-out-`/`e2e-clust-ck-<ms>-<rand>` buckets and the
stage deletes them; if that cleanup can't reach the API, the AWS, GCP or Azure
sweep step of any later run deletes them once they are three hours old.

`live_checks` (`E2E_CLUSTER_LIVE_CHECKS`, empty by default) adds the 0.1.71
pool checks to a hosted journey (`hosted_stage` or `gpu_pool`). Each
runs on this tree's pool, after any upgrade, before the journey's own
workloads, and writes a `pool-check-*` record
(`contracts/pool-checks.ts`, `substrates/cloud-cluster/pool-checks.ts`):

- `agent-restart`: once a Node's bootstrap token Secret is gone, a
  privileged `hostPID` Pod runs `systemctl restart k3s-agent` through
  `nsenter`, then reboots the host. After each one, the same Node must be
  Ready with the same `anycloud.sh/attempt`, and its kubelet Lease must be
  renewed after it. The reboot is awaited by its boot ID changing, and the
  pool's instances must be the ones from before.
- `entry-handoff` (`from_release` only): a pool Service starts on the
  released API before `api upgrade`, and a request every 250 ms goes to its
  URL through Cloudflare until a minute after every Node from the release is
  replaced. Every
  request must succeed, and the record must have moved to a new entry. The
  record keeps the request count, the longest gap and when each entry IP
  appeared.
- `pool-job-upgrade` (RFC 0049 C27, a `from_release` after 0.1.71, the
  first with C27, which the CI stamp makes the candidate's predecessor; a one-Node AWS, GCP or Azure pool of a CPU type, or `gpu_pool`
  with one replica): before `api upgrade`, two Jobs of one shape, each
  requesting the Node's GPUs on a GPU pool or just over half its vCPUs on a
  CPU pool, go to the released API. The
  first is claimed and sleeps 20 minutes between two lines it also writes to
  its output bucket; the second must stay queued behind it. When the upgrade is
  done the first must still be running, then complete once on the replica it
  started on, with no retry, both lines in its log tail and both outputs. The
  second, whose replica is read every 2 s from its submission (on the
  replacement's spare Node it can end before the upgrade does), must run on a
  replica whose `runner-install` image is the released one, and complete with
  its output. The record keeps how long the upgrade took, each Job's Node, and
  whether the second ran on the spare (`queuedOnSpare`).
- `cpu-defaults` (AWS, GCP or Azure pool): a `--disk-size 100` pool of
  the cloud's 2-vCPU, 8 GiB type (`t3.large`, `e2-standard-2`,
  `Standard_D2s_v5`) and a pool of its 1 GiB type (`t2.micro`, `f1-micro`,
  `Standard_B1s`). A Job without `--cpus` or `--memory` stages a 1.5 GB input
  and writes 3 GiB. It must complete, with a replica that requests 1 CPU, a
  memory limit equal to its request, and a disk share that holds both. Its
  Node must have room for two such replicas, and a Job past its memory must be
  OOMKilled while a neighbour on its Node keeps running. The first pool allows
  privileged Jobs, and a `--privileged` Job past its memory must be OOMKilled
  too. More such Jobs than a
  Node's vCPUs must leave a replica Unschedulable and make the pool buy a
  second Node. A default Job on the 1 GiB type must complete, with its Node's
  allocatable memory above the replica's request.
- `pool-gpu-probe`: on the journey's GPU pool (`gpu_pool`, or a
  hosted Lambda pool), or on a pool of its own on an AWS or GCP CPU journey,
  under that cloud's GPU lock: a `g4dn.12xlarge` (four T4s) on AWS, which
  also runs the co-located case, and a `g2-standard-4` (one L4, the GCP
  quota) in `us-east4`. The workflow first fails if AWS's G and VT vCPU quota
  is under 48, and a check pool fails at its first capacity error. `anycloud-gpu-fabric.service` must be loaded and have
  succeeded, and a GPU Job must complete. A Job that prints a missing-GPU line
  must rerun once in a new Pod, then end Errored with the passing check named.
  The Node must never be cordoned or labelled, no check Pod may be left, and
  each check Pod must live under its bound. On a Node with two GPUs, a Job
  holding nearly all of one GPU's memory through libcuda must not make the
  check call the Node unusable.
- `cpu-cold-start` (an AWS, GCP or Azure pool): the CPU counterpart of
  `records.gpu.coldStart`. It runs on a pool of the cloud's `cpu-defaults` CPU
  type and sets no bound on any duration. A missing time fails the check. The
  same Job runs on every release, so comparing releases is done across runs,
  not inside one. With `from_release` the check runs on the released API
  before `api upgrade` and not again after it. Without `from_release` it runs
  on this tree. The record has these points, and the duration between each
  consecutive pair:
  - `vm_launched`: the cloud API's launch time (EC2 `LaunchTime`, GCE
    `creationTimestamp`, Azure `timeCreated`).
  - `node_created`, `node_ready` and `pod_scheduled`: the control plane's
    object and condition times.
  - `image_pulled` and `container_started`: kubelet's `Pulled` Event for the
    workload container and its start.
  - `job_running`: the hosted API's first `running` event for the Job, in
    milliseconds.

  Every Kubernetes time is quantized to the second. `imagePull` keeps
  kubelet's own pull time (`elapsedMs`, to the millisecond) and whether the
  Node already had the image (`alreadyPresent`). `runnerImagePull` is the
  same for the `runner-install` init container's API image, which is pulled
  first and is most of `pod_scheduled->image_pulled`. The Job is a
  hash-locked pip install of numpy and scipy (about 57 MB) into `/cache`. It
  checks scipy's answer and records the install's wall clock, the bytes the
  Pod received during it and the cache's size before and after
  (`cache.cold`).

  On a release with RFC 0049 C11, C12 and C22 (every release after 0.1.72,
  and this tree), the check also exercises them:
  - C22: the pool is `--min-vms 0 --max-vms 1` and must start with no VM. The
    Job scales it from zero, so its Pod waits for the Node and the record
    has a `total`.
  - C11: the Node joins knowing the Job's image, so `imagePull.alreadyPresent`
    shows whether the pre-pull finished first. This is recorded, not
    asserted.
  - C12: the Job installs through `--cache pip:/cache` and must find the cache
    empty. The same Job then runs on that Node again (`cache.warm`) and must
    find exactly what the first one left.

  On 0.1.72 the pool is `--min-vms 1` and the Job runs once on the Node the
  pool started with. Its Pod came after that Node's boot, so the record has
  no `total`. Compare the Node's steps and the Pod's steps instead.

  Every check Job runs `CHECK_IMAGE` (about 43 MB compressed), the image
  `cpu-defaults` already uses. The record is `pool-check-cpu-cold-start`.

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
  with an AWS, GCP or Azure pool (`contracts/role-connections.ts`,
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
  API's token for another audience. A pool Job writes its output through the
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
The pool follows it unless `pool_provider` names another cloud. A GCP or Azure
management VM runs only the default journey (`hosted_stage` and `gpu_pool`
are refused up front until each is qualified on it), and its
cluster-side reads and sweeps are per provider. The workflow's own
sweeps then cover it from a fresh process: on GCP the management VM and its
firewall rule by `anycloud-cluster-<id>` (every `anycloud-cluster-e2e-clust-*`
when a failed create left no id) and `e2e-clust-` GCS buckets; on Azure the
installation's resources by owner in the cluster's and the pool's regions and
`e2e-clust-` containers of the shared storage account.

Dispatching with `pool_provider: gcp` keeps the cluster on AWS and runs the node
pool on GCP (`substrates/cloud-cluster/gcp-pool.ts` sweeps that side by the
product's instance label and firewall target tag). That proves what one cloud
cannot: the agent joins over the cluster's advertised public address, the
apiserver reaches the pool's kubelet through the agent tunnel (a Running
Service means its Pod was observed Ready through that path), the pool pulls
the image from its own network, and both clouds sweep clean. It does not
exercise cross-cloud Pod-to-Pod traffic, a second pool, or GPU capacity.
`pool_provider: azure` proves the same on Azure with `hosted_stage` on a
Standard_D2s_v5 in westus2, or with `gpu_pool` on the NC-series T4 there: `substrates/cloud-cluster/azure-pool.ts`
reads only the pool's tagged VMs, disks and networking in the product's shared
`anycloud-<region>` resource group, and the workflow sweeps every resource the
run's installations own there (`anycloud_cluster`, purged by owner through
`ci/cleanup/e2e-cluster-azure-pool.ts`), never the group.
`pool_provider: lambda` runs an unpinned pool of the GPU types `gpu_1x_a10` and
`gpu_1x_a100_sxm4`, so it launches in whichever Lambda region has capacity
(`pool_region` pins it):
`substrates/cloud-cluster/lambda-pool.ts` reads the pool's instances by their
`anycloud:resource` tag and its `anycloud-<pool id>` firewall ruleset, and the
workflow sweeps both through Lambda's API.

The member is born Vitest: its Integration cell is required from the first
run and it is listed under "Born-Vitest members" in
[`RETIREMENT.md`](RETIREMENT.md). Its assertion map
(`qualification/assertion-maps/e2e-cluster-local.json`) inherits the retired
member's requirement rows one-for-one, re-targeted from Cluster to cluster +
node pool, plus rows for the cluster connection, the join credential, the node pool
Service and cluster survival. Cleanup is the same LIFO stack as every constrained
member: node pool VMs and networks, the API child, the K3s server container
and the fixture image are released in reverse order with redacted evidence
records.

### Local pool scaling member (`e2e-pool-scaling-local`)

```bash
yarn test:e2e-pool-scaling-local:vitest
```

`specs/e2e-pool-scaling-local.spec.ts` runs RFC 0048's scenarios on one 1..5
pool of the same local substrate (`contracts/pool-scaling-local.ts`). The pool
is `m5.24xlarge`, catalogued larger than any runner, so the shape FIT packs
Pending Pods into equals a local Node's allocatable. Each new agent joins with
the `e2e.anycloud.sh/images` taint. The environment imports the images earlier
Nodes received and then lifts the taint, because no registry serves them. The
member waits out two idle windows, so it takes about an hour.

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
