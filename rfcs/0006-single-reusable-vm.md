# RFC 0006: Single reusable VM for sequential jobs

> Status: Proposed
> Date: 2026-06-20
> Author: Luis Fernando De Pombo
> Updated: 2026-08-16 for the first-class VM baseline and removal of `--persist`.

> Current baseline: Main now has a first-class persistent `anycloud vm`
> primitive, and migration 0083 removed persisted Job VMs and the `--persist`
> flag. The product goal below remains backlog, but its durable design must target
> an existing VM workload rather than promote or borrow a persisted Job VM.

## Summary

Add a constrained **single-worker VM** mode: a user can keep one VM alive and submit
multiple jobs to it sequentially. This is not a VM pool, scheduler, or packing system.
The goal is to use an already-paid capacity-reserved VM as warm capacity while keeping
each submitted job isolated from previous jobs.

The main design rule is: **reuse the VM, not the previous job's filesystem state**.
Docker image layers, installed runtime packages, drivers, and the VM itself may persist.
Job input/output/checkpoint directories, rclone services, secrets, and containers are
created per job and cleaned after that job reaches a terminal state.

## Context / problem

Today each workload row still owns its VM lifecycle, but main now distinguishes
the lifecycle by primitive:

- `vms.workload_id` is the VM ownership boundary. `workload-store.ts` describes the
  `vms` table as a per-workload provisioning ledger where "jobs are single-VM."
- `vm-provisioner.ts` derives the cloud VM id from the workload id.
- `conduct.deploy()` runs the whole provision -> initialize -> download -> sync -> start
  path for each workload.
- A Job always releases its VM after terminal finalization.
- A first-class VM workload keeps one long-running container and host alive until
  explicit termination, with `/workspace`, container SSH, host SSH, and host Docker
  access. It does not accept managed Jobs or their bucket-sync lifecycle.

The remaining gap is an assignment and lease model that lets a normal Job run on
an explicitly selected, already-running VM while preserving Job status, artifact
sync, cleanup, and isolation. The old `--persist` bridge no longer exists and
must not be restored as the prototype path.

## Research / precedent

Open-source schedulers that reuse long-lived machines generally solve this by making
the machine/node durable and the job allocation ephemeral:

- **SkyPilot** has "jobs on clusters" via `sky exec`: jobs are queued and run on an
  existing cluster, reusing the cluster's setup. It also re-syncs `workdir` on each
  run, so submitted code refreshes even though the cluster stays alive.
  - https://docs.skypilot.co/en/latest/overview.html
  - https://docs.skypilot.co/en/stable/reference/job-queue.html
- **dstack** has reusable fleets. Runs can reuse idle VM-based instances, and
  `idle_duration` controls how long those instances stay alive when unused.
  - https://dstack.ai/docs/concepts/fleets/
  - https://dstack.ai/docs/reference/dstack.yml/task/
- **Kubernetes** keeps nodes long-lived while Jobs create Pods. Pod-scoped ephemeral
  volumes disappear with the Pod; persistent volumes are explicit. Kubelet garbage
  collects unused containers/images.
  - https://kubernetes.io/docs/concepts/workloads/controllers/job/
  - https://kubernetes.io/docs/concepts/storage/volumes/
  - https://kubernetes.io/docs/concepts/architecture/garbage-collection/
- **HTCondor** runs jobs on long-lived execute machines using a per-job scratch
  directory and explicit file transfer. The scratch directory is unique per job and is
  deleted when the job stops.
  - https://htcondor.readthedocs.io/en/lts/users-manual/env-of-job.html
  - https://htcondor.readthedocs.io/en/23.0/users-manual/file-transfer.html
- **Slurm** keeps compute nodes long-lived and uses Prolog/Epilog scripts for
  per-job setup and teardown.
  - https://slurm.schedmd.com/prolog_epilog.html

The common pattern is not "carefully sync previous state into the next job." The common
pattern is **per-job isolation with explicit persistence**.

## Proposal

Extend the first-class VM primitive with an explicit **single reusable VM
target**. A user creates a VM, opts it into managed Job execution, then targets
it explicitly. The flag name remains a product/API decision; an illustrative
flow is:

```bash
anycloud vm ghcr.io/acme/worker:latest --id warm-worker --credentials my-aws --gpu-type h100
anycloud job ghcr.io/acme/train:latest --reuse-vm warm-worker -- python train.py
```

Only one job can hold the reusable VM lease at a time. If another job targets the same
VM while it is busy, the job stays queued or fails fast depending on the CLI/API option
chosen later.

### User-facing semantics

- The VM stays alive across jobs until the user terminates the reusable VM.
- Each submitted job still has its own workload id, status, logs, terminal state, and
  output/checkpoint bucket behavior.
- A job completing does **not** terminate the VM. It final-syncs, cleans its per-job
  runtime state, and releases the VM lease.
- A job termination stops that job's container/services and releases the VM. It does not
  kill the VM unless the user terminates the reusable VM itself.
- No cross-job checkpoint inheritance in v1. If users want state transfer, they should
  use explicit buckets or a later, explicit "inherit checkpoint from job X" feature.

### VM state model

Keep the existing first-class VM workload as the durable worker record. Add a
lease/assignment relation instead of a parallel `reusable_vms` table or a
completed Job owner. Minimal new shape:

```text
job_vm_assignments
  workload_id
  vm_workload_id
  state              assigned | released | failed
  assigned_at
  released_at nullable
  lease_expires_at nullable
```

This deliberately separates:

- **VM lifetime**: the existing `workloadType=vm` workload and its VM ledger
- **job lifetime**: `workloads`
- **job-on-VM lease**: `job_vm_assignments`

### Per-job filesystem layout

Do not reuse global `/mnt/input`, `/mnt/output`, `/mnt/checkpoint` as host paths across
jobs. Instead, use per-job host paths:

```text
/var/lib/anycloud/jobs/<workload-id>/input
/var/lib/anycloud/jobs/<workload-id>/output
/var/lib/anycloud/jobs/<workload-id>/checkpoint
/var/lib/anycloud/jobs/<workload-id>/secrets.env
/var/lib/anycloud/jobs/<workload-id>/rclone/
```

The container still sees the familiar paths:

```text
/mnt/input
/mnt/output
/mnt/checkpoint
```

but those are bind-mounted from the workload-specific host directory.

### Per-job services

Current rclone service names are generic (`rclone-output`, `rclone-checkpoint`). Reusable
VM mode should use per-job service names:

```text
anycloud-rclone-output-<workload-id>
anycloud-rclone-checkpoint-<workload-id>
anycloud-input-sync-<workload-id>
```

Cleanup for a job should stop/remove only services for that workload id.

### Job start path on a reusable VM

For VM-host providers only:

1. Acquire the reusable VM lease atomically.
2. Health-check SSH and Docker.
3. Run a cleanup preflight for this workload id and any known stale AnyCloud services.
4. Create per-job directories.
5. Resolve bucket credentials and write per-job rclone config/env files.
6. Pull the Docker image. Docker layer cache persists across jobs.
7. Run input sync if configured.
8. Start output/checkpoint sync services if configured.
9. Start the job container named by workload id.
10. Monitor completion using the existing Docker inspect path.
11. Final-sync output/checkpoint.
12. Stop per-job services, remove secrets, remove per-job directories according to
    retention policy, release the reusable VM lease.

### What persists across jobs

Allowed to persist:

- Docker image layers
- Docker daemon state unrelated to old AnyCloud containers
- installed Docker/rclone/NVIDIA/runtime packages
- VM-level logs
- explicit user bind mounts, if a later version allows them and the user accepts the
  isolation tradeoff

Must not persist implicitly:

- `/mnt/input`, `/mnt/output`, `/mnt/checkpoint` contents from prior jobs
- rclone services or config for prior jobs
- named secrets or env files
- old job containers
- old checkpoint state

## Implementation sketch

### Increment 0: research prototype

Constrained prototype:

- user creates a first-class VM workload and explicitly enables managed Job use
- `anycloud job --reuse-vm <vm-workload-id>` leases that VM workload's host
- one active reused job at a time
- no scheduler-native/Kubernetes path
- strict cleanup and no cross-job state

This validates the runtime path without reviving removed Job persistence. The
prototype still needs a real ownership check and an atomic lease; manual SSH into
the VM is not an acceptable coordination mechanism.

### Increment 1: first-class reusable VM

Add `job_vm_assignments` and lease state to the existing VM workload model,
then support explicit target submission. The provision scheduler can branch:

- normal queued workload -> existing `deploy()`
- queued workload with reusable VM target -> `deployOnReusableVM()`

`deployOnReusableVM()` skips cloud provisioning and VM initialization, but reuses the
existing image pull, rclone setup, Docker start, job completion, and finalization logic
after those functions accept a VM source independent of `workload_id`.

### Increment 2: hardening

- stale lease recovery after API restart
- worker health monitor
- drain/terminate reusable VM command
- cost reporting for reserved VM time versus per-job assigned time
- integration tests for failed jobs, terminated jobs, stale rclone services, and
  repeated sequential submissions

## Work estimate

For the constrained beta:

| Area                                      | Estimate |
| ----------------------------------------- | -------- |
| DB + lease model                          | 1-2 days |
| Submit/API surface                        | 1 day    |
| Reusable-VM deploy branch                 | 2-3 days |
| Per-job filesystem + rclone service names | 3-5 days |
| Completion/termination/release semantics  | 2-3 days |
| Status/list/cost/test/docs                | 3-5 days |

Total: **8-15 engineering days** for a beta that is safe enough to try with one VM.

A hacky prototype could be **3-5 days**, but would likely have correctness issues around
stale rclone services, leaked `/mnt` state, failed job cleanup, and confusing status or
cost reporting.

Production-grade is closer to **3-5 weeks**. The first-class VM removes the need
to invent another durable worker resource, but `vms.workload_id` remains the
ownership boundary and the Job runtime still assumes it owns provisioning,
artifact services, completion, and host cleanup.

## Alternatives considered

### Use a first-class VM manually

The VM survives and users can run work through `anycloud ssh` or `anycloud exec`,
but there is no assignment model for Job workloads. Manual execution loses
normal Job status, bucket hydration/final sync, retries, isolation, and
cost/history accounting.

### Build a VM pool

Too much for the immediate use case. A pool needs matching, fair scheduling, capacity
bin-packing, multi-worker health, and queue policy. This RFC intentionally supports one
explicitly targeted VM first.

### Reuse the previous job's state

Rejected for v1. It makes correctness hard: stale output can upload to the wrong bucket,
old checkpoint files can affect new jobs, and old secrets/rclone config can leak. If
state inheritance is useful later, it should be explicit and bucket-backed.

### Use Kubernetes/Nomad/Slurm instead

Those systems already solve node/job separation. Pulling them in would impose a much
larger operational dependency than AnyCloud's current SSH-based VM model. The useful
lesson is their allocation pattern, not necessarily their control plane.

## Risks & caveats

- **State leakage** is the main risk. Per-job host directories, per-job rclone services,
  and strict cleanup are not optional.
- **Secrets leakage** gets worse on a reused host unless secrets are per-job files and
  removed at release.
- **Cost attribution** becomes less exact. The capacity-reserved VM burns cost while idle;
  per-job cost should probably show assigned wall time plus a note that VM idle time is
  owned by the reusable VM.
- **Preemption recovery is not the goal.** This feature is primarily for reserved or
  stable on-demand capacity. Spot reusable VMs add awkward semantics and should be out of
  scope for v1.
- **Scheduler-native Kubernetes is out of scope** because it runs the workload
  through a cluster controller, not as a Docker container on a reusable host
  controlled by AnyCloud.
- **Concurrent jobs are out of scope** for v1. One VM, one active job.

## Open questions

- Should `--reuse-vm` queue behind the active job or fail fast if the VM is busy?
- Should every first-class VM be targetable, or must creation/update explicitly opt
  into managed Job leases?
- How much per-job disk state should be retained after completion for debugging?
- Should Docker images be garbage-collected by AnyCloud, or left to Docker/Kubelet-like
  image GC policy later?
- How should cost reporting split reserved idle cost versus assigned job cost?
- Is explicit checkpoint inheritance worth a later v2, or should users always use
  buckets for cross-job state?

## Decision

Pending. VM reuse remains backlog. Any future implementation must extend the
current first-class VM primitive and must not depend on the removed `--persist`
flag or introduce a second durable VM resource without a demonstrated need.
