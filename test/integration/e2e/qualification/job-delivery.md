# Dedicated Job implementation delivery

The foundation delivers the Local held Job. The core batch
adds Local natural completion and same-ID resubmission, four cloud bucket-sync
members, and AWS/Azure/GCP concurrent output. Later batches add admission,
configuration, recovery, and six provider/image members. Specs select a closed member
through `e2e.contracts.dedicatedJob({ kind, target })` and assert completion.
The family owns lifecycle decisions, waits, evidence and finalization.

| Kind                       | Targets                 | Isolated command                                                       |
| -------------------------- | ----------------------- | ---------------------------------------------------------------------- |
| `local-held`               | `local-smolvm`          | `bash test/integration/e2e.sh local-held-job --vitest`                 |
| `local-completed`          | `local-smolvm`          | `bash test/integration/e2e.sh local-completed-job --vitest`            |
| `local-resubmitted`        | `local-smolvm`          | `bash test/integration/e2e.sh local-resubmitted-job --vitest`          |
| `bucket-sync`              | AWS, Azure, GCP, Lambda | `bash test/integration/e2e.sh <target>-bucket-sync --vitest`           |
| `concurrent-output`        | AWS, Azure, GCP         | `bash test/integration/e2e.sh <target>-concurrent-output --vitest`     |
| `host-recovery`            | AWS, Azure, GCP         | `bash test/integration/e2e.sh <target>-job-host-unreachable --vitest`  |
| `input-hydration-recovery` | AWS                     | `bash test/integration/e2e.sh aws-input-hydration-recovery --vitest`   |
| `spot-request-cleanup`     | AWS                     | `bash test/integration/e2e.sh aws-spot-request-cleanup --vitest`       |
| `spot-eviction`            | AWS, Azure, GCP         | `bash test/integration/e2e.sh <target>-spot-eviction --vitest`         |
| `gpu-spot-eviction`        | Azure                   | `bash test/integration/e2e.sh azure-gpu-spot-eviction --vitest`        |
| `gpu-probe-rerun`          | AWS, Azure, GCP, Lambda | `bash test/integration/e2e.sh <target>-gpu-probe-rerun --vitest`       |
| `runtime-secrets`          | AWS, Azure, GCP, Lambda | `bash test/integration/e2e.sh <target>-runtime-secrets --vitest`       |
| `restricted-credential`    | AWS, Azure              | `bash test/integration/e2e.sh <target>-restricted-credential --vitest` |
| `host-docker`              | AWS, Azure, GCP         | `bash test/integration/e2e.sh <target>-host-docker --vitest`           |
| `invalid-admission`        | AWS, Azure, GCP         | `bash test/integration/e2e.sh <target>-invalid --vitest`               |
| `disk-tier`                | GCP                     | `bash test/integration/e2e.sh gcp-disk-tier --vitest`                  |
| `mace-full-pull`           | AWS, Azure, GCP, Lambda | `bash test/integration/e2e.sh <target>-mace-full-pull --vitest`        |
| `ghcr-probe`               | Azure                   | `bash test/integration/e2e.sh azure-ghcr-probe --vitest`               |
| `arm64`                    | AWS, GCP (Azure: none)  | `bash test/integration/e2e.sh <target>-arm64 --vitest`                 |

Each delivered member has an assertion map under `assertion-maps/`; its
retirement state is a row in [`../RETIREMENT.md`](../RETIREMENT.md). The
source-bound implementation maps that once sat beside them were deleted in W1
of the Lane A trim (last at git `90aee3d021dad5f4a2792c901e6ff78b786832f7`).

Fixed provider registrations describe storage, transfer and recovery
capabilities separately from placement. Shared behavior consumes those
capabilities. Local transport owns its exact host/root/directory identities;
the family owns waits and assertions. The original complete database reader
and Workload cleanup hook remain the shared owners.

Native cleanup uses independent teardown clients and keeps every validated
attempt prefix, original identity, ended attempt and authorized send. A missing
reply or incomplete inventory cannot release a reference. Each send waits for
its own inventory fence and has no implicit replay. Original controller URL and
incarnation are bound separately from logical Job generations. Attempt reads
check that binding before and after awaiting the database, and create/resubmit
check it again immediately before the tracked mutation. A replacement response
cannot enter original attempt history. Local bucket cleanup
requires native-child absence and independently inventories the original root.
The existing private Workload reservation hook also binds that controller for
Job mutation, termination, cleanup-read and release operations. Its actual
foreground and teardown clients must match; replacement leaves tracking armed.
AWS registrations additionally consume the shared reservation observer:
a lost launch reply can leave a native VM behind the original client token. Every historical reservation retains its original coordinates and
credential. Complete inventory and independent absence of every discovered
native ID are required; a partial inventory retains its validated matches even
if a later request fails. These matches do not invent database rows or resolve a
later submission. Local name completion, GCP zone completion and Lambda native-ID refinement
require their recorded, provider-specific same-row identity relationship. Local
cleanup still requires its complete owned-machine inventory.
Cloud storage binds original account/project/subscription, exact native bucket
identity and API presence; an empty object list cannot establish absence.
Automatic output/checkpoint placement follows the observed compute region where
the registered capability requires it. Cross-cloud placement stays fixed.
Credential and bucket intent precede mutation, and original-controller fences
run immediately before sends. Generated credentials outlive dependent storage
and all native children. Secret deletion reads back the exact deleted name
through the declared schema with one deadline for deletion and readback.
The existing SecretManager binds each bundle's original controller before
creation and retains that binding after removal. Save, force deletion and
independent cleanup reject a replacement incarnation; uncertain readback keeps
the existing cleanup registration armed. Explicit new bundle intents may use a
restarted controller without moving earlier cleanup obligations to it.

The runtime-secret member submits two `t3.small` Jobs with independent
900-second Running budgets. The first checks three values from two bundles and
the cluster-owned mode 0600 tmpfs file; the second verifies that explicit `--env`
overrides the bundle value. After force deletion with exact-name absence, the
same container ID, start time and original attempt must still expose the
injected values. Only digest comparisons leave the containers. Both children
must be absent before the family releases remaining bundles and the imported
API credential. The API/auth owner retains CRUD/privacy, missing/deleted-name
admission and non-force 409/reference assertions; these are not duplicated in
the Job contract.

The three invalid-admission members preserve seven named requests: AWS/GCP
reserved input buckets and pinned-region fake VM types, and Azure fake VM plus
the pinned CUDA-image/ROCm-VM guard and explicit Docker GPU rejection. Each uses the supplied shared
admission owner, an original-controller/credential inventory fence and one
tracked SDK send. A declared 400 rejection requires complete zero-row history
and a fresh original-controller API absence before release. The acknowledged
Azure guard instead requires the exact Invalid event and persisted cleanup,
without any provisioning attempt. Lost replies, earlier attempts, incomplete
history, controller changes and unrelated errors cannot satisfy either path.
The family alone claims each original case record and emits completion after
all cases and dependent API credential cleanup. Only proven non-creation emits
the exact forced-cleanup classification `Not applicable`; no forced mode runs
these members. They share the existing Integration no-provision matrix and
retain compact records for 30 days.

The GCP disk-tier member runs seven serial cases: omitted tier on E2,
medium/high/ultra and its own 3,000 IOPS / 750 MiB/s on C4, and medium/ultra on
E2. It reads each original native
VM and boot disk through the existing provider reader, checks the native disk
type, and requires 100 GiB with 8,000/16,000 IOPS and 1,000 MiB/s for high/ultra
Hyperdisk, and 3,000 IOPS and 750 MiB/s for the Job's own. The next case cannot submit until actual cleanup of the prior case;
all references remain armed until the single family finalizer claims all seven
case records. Its forced failure follows the seventh native assertion while that
last child is still live. Existing 1,200-second Running and 2,700-second cleanup
budgets remain independent per case. Its cell is required and shares the GCP
provider lock with the other GPU jobs.

The four MACE members use the original digest-pinned image and provider profiles:
AWS `g6e.xlarge`, Azure `Standard_NC4as_T4_v3`, GCP `g2-standard-4` in `us-east4`,
and Lambda `gpu_1x_a10`. They keep the original disk defaults and on-demand
placement, with no unrelated storage fixture. The existing observer arms before
submission, records the original run's CUDA inference, and joins its child
process. Its deadline cannot reset after Running. The family requires exit zero,
the pinned manifest, and a successful containerd transfer or explicit successful
Docker fallback from the original API container. It uses the existing schema-2
MACE reports on success and failure. Forced cleanup follows the live baseline,
before inference finalization; independent cleanup reaps the observer before
the existing native owner removes the Job.

The Azure GHCR member holds its original Ubuntu GPU Job and runs the unchanged
throughput and containerd payloads on a pinned SSH host. The probe image remains
separately pinned; original sample, ladder, disk, placement and pull settings are
explicit profile fields. The initial SSH pin and each later command use the
existing Job environment sanitizer and suppress raw command artifacts. Unit intent precedes the detached start, so a lost reply
still leaves owned diagnostics and native cleanup. The payload must prove Docker
visibility, supported transfer and its own daemon cleanup. A later VM deletion
cannot repair a failed automatic-cleanup assertion. Baseline measurement stays
off by default; when requested, it must be cold, error-free and slower than the
transfer using finite positive rates. The 1,200/2,400-second pull and
3,600/5,400-second runner limits retain their original meaning. Forced cleanup
follows detached launch while the original host is live. SSH material and unit
diagnostics use an independent cleanup scope; only the family releases the Job.

The GPU workflow retains its Service companions, provider locks and cleanup
backstops. Four MACE cells and one seven-case disk cell use separate results. `mace_only` excludes Service/disk cells and account sweeps on both sides,
and still requires tracked cleanup. The GHCR probe-only dispatch runs one
required Vitest cell with the original baseline inputs and the existing Azure GPU
provider lock; its targeted cleanup adds no account-wide Azure sweep. Both workflows
accept `force_job_cleanup` only in their Job cells and retain compact successful
and failed observations for 30 days, alongside existing diagnostics. An outer
workflow success does not accept the inner outcome or raw cleanup registrations.

AWS/Azure/GCP bucket recovery retains the original native VM and boot-disk IDs.
Pre-fault checkpoint and identity evidence must precede the stop; a fresh
Running attempt must retain both identities and the checkpoint values. Recovery
uses the existing production watchdogs. The host-recovery members separately
delete the exact original host and require a distinct replacement, the retained
ended original attempt and a new cloud-confirmed termination reason. Azure's
registered checkpoint capability creates one explicit bucket in eastus on the
selected compute identity, verifies upload before deletion and exact restored
contents afterward. AWS/GCP host members create no storage fixtures. Running,
detection, replacement and cleanup retain their 900/180/1,200/2,700-second
budgets. The host forced-cleanup boundary follows replacement and restoration,
so both hosts remain owned until cleanup. These records reuse the existing
pre-fault/post-fault and resource-cleanup artifacts.

The AWS hydration member retains the real 2,048 × 128 MiB fixture, its original
32 copy workers, 350 GiB gp3 medium disk and production timing. It observes
Syncing while a hard restart of the same API container adopts the same detached
worker, then proves at least 870 seconds of healthy activity. Hiding the visible
log must leave the worker's renamed log growing; the production 900-second
inactivity watchdog must trigger a new worker invocation on the exact same VM
and boot disk. Completion validates all 256 GiB and first/middle/last shard
hashes. The shared copy and mounted-data payloads live under `fixtures/`. The forced
cleanup check follows same-worker API adoption, before the long timing windows.
An existing cleanup-stack registration restores only the original controller
container in an independent cancellation scope before Workload cleanup.
The Spot member binds the persistent request to its original VM/account/region,
then requires cancellation, a full 90-second no-replacement guard and a final
cancelled readback. Its fallback cancels owned requests before VM termination;
partial or lost replies retain known request and instance identities. Rescue
cannot erase a failed automatic-cleanup assertion.
Concurrent output submits all three children, grants each its own Running
budget, checks all three contents after sync and termination, and keeps shared
storage until every child is absent. One member completion record is emitted
only after every child and all shared resources have been released. Resubmission retains one armed reference
through first-generation cleanup and the second send's new inventory fence.
Its forced check reaches a live second generation within the existing
300-second budget, preserves every ended first-generation row, and records
exactly one new live attempt and one own resubmission event before the fault.
Its native cleanup record must account for both authorized sends before release.

For implementation failure evidence, set `force_job_cleanup=true` on the
Integration workflow for Local. Job failure mode outside that lane is
rejected.

The named fault runs after active assertions and before recovery/finalization;
the concurrent member first proves all three outputs. An expected injected
failure is not success by itself: inspect `fixture-record.json`,
`cleanup-observations.json`, native attempt/absence records, bucket and
credential records, and the outer `e2e-run.json`. All armed registrations must
complete and no unresolved Workload may remain before the broad provider or
Local backstop. Compact Job evidence artifacts are protected for 30 days;
existing failure diagnostics and independent backstops remain.

The API-only outer runner cannot discharge a Job registration retained by the
native owner. Secret assertion failures retain their reason without printing raw environment
or API response bodies. The member's native, bucket and credential
registrations remain separate evidence. Compact records exclude
raw commands, environments and logs. Rescue cleanup cannot replace the
member's original failed automatic-cleanup assertion.

The Job workflow retains failure diagnostics and every provider cleanup and
generated-credential sweep; the sweeps wait for the members.

Contracts/adapters, execution and cleanup owners, and their regressions are
permanent test infrastructure. The shared MACE Python payload, observer and
report builder, and both GHCR shell payloads are dependencies of the Vitest
members. Assertion/history records and retained run evidence keep their
required lifetimes.

The optional `azure_identity_readback` input on `e2e-job.yml` addresses an
unresolved generated identity from a declared `azure-bucket-sync` attempt. Its
existing Azure backstop runs `inspect:azure-job-identity` after the credential
sweep, using the original CI material hash and subscription binding. The reader
uses the existing private process/session harness for at most four read-only
commands, 30 seconds each including process termination grace, within 120 seconds;
there are no retries or mutations. It retains exact app/SP observations, partial
failures, process receipts, and distinct original/observer source/run bindings for
30 days. Unknown or present identities fail the selected readback. A later absence
never changes the original failed automatic-cleanup record. Remove the reader
from `e2e-job.yml` and `managed-gpu-recovery.yml` once its exact cleanup
obligations are resolved.

For an isolated readback, the existing manual `managed-gpu-recovery.yml` workflow
accepts the same optional JSON input. A nonempty selection runs only the reader;
the default continues to run managed GPU recovery with its existing authority.
The request must match the required `original_run_id` and `original_run_attempt`
inputs before authentication. The reader uses the Azure onboarding lock and the
same original CI credentials, command budget and receipt. Its job has a ten-minute
limit, including a five-minute dependency install and a three-minute reader step.
Shared-account coordination still applies because other Azure backstops do not
all acquire that lock. This entry shares the reader's deferred removal point.
