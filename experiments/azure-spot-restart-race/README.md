# Azure spot restart race experiment

- Status: Provider race confirmed; production qualification pending.
- Decision record: the candidate gateway's settle-before-start policy, below.
- Historical probes: 33922794004
  and 33977229915.
- Run: `yarn spike:azure-spot-restart-race` against an `az login` session or
  explicit Azure service-principal credentials.

## Problem

An Azure spot eviction can supersede a start issued while the eviction is
still running. Azure reports that start operation as successful, but the VM
remains deallocated. The original gateway immediately calls `beginStart`,
then uses the provisioning reader to wait for readiness. That reader throws
on its first deallocated observation, so the monitor replaces the VM and
loses its managed OS disk and image cache.

Two failures in Job run 34897240084
reproduced this ordering on September 14: the start requests preceded
completion of Azure's eviction by 3.222 seconds and 1.214 seconds. Both start
operations reported success, both VMs remained deallocated, and both tests
failed the required same-VM recovery assertion. These observations establish
a failure mechanism; they do not estimate its frequency across deployments.

## What it probes

One spot VM (`Standard_D2s_v5`, `austriaeast`, `evictionPolicy=Deallocate`),
evicted and restarted repeatedly across three arms:

- **Arm A:** Start as soon as power state leaves `running`, reproducing the
  original gateway's race with eviction.
- **Arm B:** Wait for three consecutive stopped/deallocated observations,
  then start. This measures recovery after the eviction settles.
- **Arm C:** Arm A plus one reissued start after 60 seconds without recovery.

Each repetition records power and provisioning state, whether power state is
absent, the start operation's duration and rejection, and Azure activity-log
ordering. Observation extends beyond the gateway's five-minute deadline to
separate a lost start from delayed convergence. The experiment calls Azure
directly; its results do not qualify a changed production gateway.

## Historical results

The September 4 probe ran three repetitions per arm; the September 5 probe
ran five each for A and B. Together they contain **19 eviction repetitions**.

| Arm                             | September 4                 | September 5   | Combined |
| ------------------------------- | --------------------------- | ------------- | -------- |
| A: immediate start              | 1/3 recovered               | 0/5 recovered | 1/8      |
| B: settled start                | 3/3 recovered               | 5/5 recovered | **8/8**  |
| C: immediate start plus reissue | 3/3 recovered after reissue | Not run       | 3/3      |

Count each measured start request separately when comparing power state at
issue time. This includes C's reissues and excludes between-repetition reset
requests; it is a different denominator from eviction repetitions.

| Power state at start request | September 4     | September 5             | Combined  |
| ---------------------------- | --------------- | ----------------------- | --------- |
| `deallocated`                | 6/6 took effect | 5/5 took effect         | **11/11** |
| `starting`                   | 0/5 took effect | 0/4 took effect         | **0/9**   |
| `deallocating`               | 1/1 took effect | 0/1; `AllocationFailed` | 1/2       |

The September 4 trace contains **12 measured start requests**, all reporting
successful Azure operations, including five lost starts. The September 5
trace adds ten requests, including four more accepted but lost starts and
one explicit `AllocationFailed`. Lost starts did not recover during the
600-second observation window. Waiting longer after an ineffective request
alone did not repair them.

After the explicit allocation failure, the September 5 probe observed failed
provisioning with absent power state. Its subsequent reset start recovered
the existing VM. A generic failed provisioning state therefore cannot be
treated as proof that the VM is permanently unrestartable. Azure documents
[provisioning state as the last control-plane operation's result](https://learn.microsoft.com/en-us/azure/virtual-machines/states-billing)
and [retrying allocation failures](https://learn.microsoft.com/en-us/troubleshoot/azure/virtual-machines/windows/allocation-failure).

The earlier summary overstated the request count and treated a bounded
reissue as mandatory. Three successful C reissues show that a lost start can
be repaired; they do not show that B's settle gate requires another start.
Per-request traces and provider ordering take precedence over an arm-level
verdict, since an immediate start can happen to land after eviction settles.

## Promotion criteria

The candidate waits for three stopped/deallocated observations at
the production five-second cadence before issuing one start. It also handles
a repeated, known allocation failure on an existing VM when power state is
absent. Transient or unexplained missing state does not authorize a start.
Three ready observations with an IP complete recovery; transient stopped and
stale provisioning reads after an accepted start remain within the readiness
wait. The settle phase is capped at three minutes inside an absolute
five-minute deadline, including Azure SDK operations.

A causal regression must fail on the original gateway and pass on the
candidate. The exact candidate must then pass real Azure bucket-sync recovery
with unchanged Azure VM and managed-disk identifiers, plus host-loss
replacement and checkpoint recovery. Preserve source SHAs, observations,
workload evidence, and cleanup results in the linked issue and PR. Historical
probe passes are separate from these production qualification results.

Add at most one bounded reissue only if qualification of the candidate shows
that its settled start can still be lost. Preserve that counterexample, add
its regression, and requalify the revised implementation within the same
total deadline. A capacity refusal is a valid replacement outcome, not proof
that all same-VM assertions should be removed.

## Configuration

Requires `AZURE_SUBSCRIPTION_ID`, plus either the CI service-principal
variables (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`) or a
local `az login` session. Optional overrides:

- `ANYCLOUD_SPOT_RACE_ARMS` (default `A,B,C`)
- `ANYCLOUD_SPOT_RACE_REPETITIONS` (default `5`)
- `ANYCLOUD_SPOT_RACE_REGION` (default `austriaeast`)
- `ANYCLOUD_SPOT_RACE_VM_SIZE` (default `Standard_D2s_v5`)
- `ANYCLOUD_SPOT_RACE_OBSERVE_SECONDS` (default `600`, must exceed `300`)
- `ANYCLOUD_SPOT_RACE_OUTPUT` (default `./azure-spot-restart-race.json`)

Every resource lives in a dedicated `anycloud-spot-restart-spike-*` resource
group, deleted on every exit path including signals. The run fails if the
group survives cleanup.

For the focused production check, run `yarn spike:azure-spot-restart-recovery`
(`experiments/azure-spot-restart-race/candidate-recovery.ts`) with explicit
service-principal credentials and `ANYCLOUD_SPOT_RACE_REPETITIONS=10`. Supply
`CIPHER_KEY` and an isolated `ANYCLOUD_DIR` as required by the production
composition. It attempts to induce the failed-allocation state, then
calls the candidate gateway against real Azure clients. A qualifying start
requires three actual failed-allocation reads with absent power state,
unchanged Azure VM and OS-disk identifiers, and a preserved guest disk marker.
Failure to exercise the case fails qualification. All resources belong to
one `azure-restart-qualification-<run>-<attempt>` group in CI (a random suffix
locally), whose deletion is confirmed. Set `ANYCLOUD_SPOT_RACE_OUTPUT` to retain
the small JSON trace and cleanup receipt.

Cancellation aborts the candidate's SDK requests and starts cleanup immediately.
Each observation is saved before continuing so the trace survives a process kill.
For interrupted CI runs, invoke the independent cleanup command
`yarn spike:azure-spot-restart-recovery --cleanup` with the original run identity.
It derives the exact group
from `GITHUB_RUN_ID` and `GITHUB_RUN_ATTEMPT`, verifies both ownership tags, and
requires a confirmed 404 after deletion. Retain its separate receipt beside
the probe trace, including after cancellation or probe failure.

The dedicated Actions launcher was removed when the shared
[Spike dispatcher](../README.md#github-actions) was introduced. Historical run
links above remain the evidence for the original investigation; the commands
here are the executable entrypoints.

Induction requests sample delays from zero to ten seconds after the first
non-running observation. Guest marker checks use managed Run Command with a
60-second script timeout inside a five-minute SDK deadline. The seed command
is deleted before eviction so boot cannot recreate the marker.
The marker is flushed to disk, and its SHA-256 checksum is confirmed before
eviction and after each recovery.

## Deletion criteria

Keep the experiment executable until the reviewed fix ships with regression
coverage and the shipped implementation passes five consecutive Azure
bucket-sync preemption legs with confirmed cleanup. Then preserve the durable
evidence summary and remove this directory and its package
entrypoints. These five passes support retirement; they do not replace direct
qualification of the production policy.
