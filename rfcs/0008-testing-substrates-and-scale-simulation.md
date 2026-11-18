# RFC 0008: Testing layers and deterministic scale simulation

> Status: Accepted
> Date: 2026-06-21
> Author: Luis Fernando De Pombo
> Updated: 2026-08-16 for the implemented smolvm harness and 20-way PR nuke gate.

> Outcome: Phase 0a, the `FakeTransport` Tier 1 core, and the smolvm Tier 2
> harness are implemented. Real-cloud qualification remains a distinct tier.

## Summary

Keep `test/STRATEGY.md` as the operational command-and-coverage guide and use
this RFC for the testing architecture. The stack has four distinct layers:

| Tier | Layer                | Purpose                                                       |
| ---- | -------------------- | ------------------------------------------------------------- |
| 0    | pure functions       | decision correctness without fake state, transport, or clocks |
| 1    | in-process fakes     | deterministic orchestration, retry, teardown, and scale tests |
| 2    | local real execution | real microVM, SSH, Docker, sentinels, and cleanup             |
| 3    | real cloud           | provider provisioning, quotas, networking, and cloud timing   |

Tier 2 uses the undocumented `CloudType.Local` provider backed by disposable
smolvm guests. It is test infrastructure, not a public product surface. The
public CLI and local API startup do not expose or configure it.

## Why the layers stay separate

Anycloud has two testing problems that should not be collapsed:

1. Scale bugs usually come from orchestration timing, fan-out, retry storms,
   teardown races, and database state. Those need deterministic in-process
   tests that can drive thousands of workloads without wall-clock time or
   cloud quota.
2. The runtime path is SSH-heavy. Anycloud installs and starts Docker, pulls
   images, launches workloads, reads sentinels, tails logs, executes commands,
   and cleans up over SSH. Fakes can model the contract, but cannot prove a real
   SSH handshake, Docker daemon behavior, or literal command compatibility.

Tier 1 and Tier 2 are complementary. Tier 1 is deterministic and cheap enough
for production scale simulation. Tier 2 is realistic enough to catch drift in
the VM-host runtime path. Neither replaces provider-specific cloud tests.

Existing seams support this split:

- `VmTransport` and `createTransport()` define the runtime boundary;
- `SSHManager` implements the production transport;
- `FakeTransport` supplies command-addressed unit behavior;
- `makeMockCloudCompute()`, seed helpers, and fake timers support scale tests;
- `Local` supplies real disposable VM hosts without cloud credentials.

## Target tiers

```text
Tier 0  pure
  value -> value tests
  owns disposition, recovery choice, backoff, and alert-dedup truth tables

Tier 1  fakes
  FakeCloud + FakeTransport + optional stateful FakeVM under fake timers
  owns fan-out, retries, finalization, teardown races, and large-scale state

Tier 2  local real execution
  API -> smolvm -> Linux microVM -> SSH -> Docker workload
  owns transport/runtime compatibility and resource cleanup

Tier 3  real cloud
  existing provider E2E, qualification, and manual nuke lanes
  owns cloud APIs, quotas, images, networking, preemption, and real timing
```

## Tier 2: smolvm harness

The Linux CI runner prepares a pinned smolvm service bound to loopback and a
versioned stopped `.smolmachine`. The image contains the normal cloud-image
utilities, pinned Docker/rclone binaries, Docker `overlay2` state on the ext4
storage disk, and the fixed nuke workload image, but no host or workload
identity. Each workload cold-boots with private qcow2 disk overlays backed by
immutable content-addressed bases, maps guest port 22 to a unique host port,
and runs the production startup script unchanged. `initializeVM` verifies the
installed tools and starts the independent Docker daemon.

The Local gateway owns one typed runtime containing the fixed loopback
endpoint, sidecar path, and SSH hostname. The container runs with host
networking so both SmolVM HTTP and mapped SSH ports are reachable. It never
receives the runner's Docker socket.

The primary commands are:

| Command                                              | Coverage                                  |
| ---------------------------------------------------- | ----------------------------------------- |
| `yarn local-runtime:setup`                           | pinned runtime and service readiness      |
| `yarn test:local-smolvm:runtime`                     | image, boot, SSH, init, and host contract |
| `./test/integration/e2e.sh local-smolvm-job`         | complete VM-host workload lifecycle       |
| `./test/integration/e2e.sh local-smolvm-sdk-python`  | Python SDK Local wire contract            |
| `NUKE_PROVIDER=local ./test/integration/e2e.sh nuke` | concurrent lifecycle/load test            |
| `yarn local-runtime:cleanup`                         | prefix-scoped microVM cleanup             |

The lifecycle E2E must verify:

1. a normal API request selects `CloudType.Local` without credentials;
2. provider preflight creates, reaches, and deletes a smoke guest;
3. the workload reaches Running through real SSH and Docker initialization;
4. environment values, named secrets, GitHub auth, labels, and Docker resource
   options reach the workload;
5. exec and stdout/stderr logs flow through the API;
6. user SSH and public endpoint details remain unavailable;
7. explicit termination removes the workload VM;
8. exit-zero and exit-nonzero completion record the right state and clean up;
9. same-ID resubmit creates a fresh attempt without leaking a guest.

Capability failure is a hard failure in CI. An explicitly scheduled harness
lane must not turn missing KVM, a bad checksum, a version mismatch, an
unreachable service, or failed smoke SSH into a green skip.

### Local nuke

The Local nuke lane retains the same seeded historical database, 20-way submit
burst, list/status responsiveness probes, memory sampling, lifecycle accounting,
and cleanup drain as before. The provider branch changes only substrate inputs:

- no cloud credentials, spot request, or object-storage sync;
- ordinary credentialless CLI submission, with Local selected by the API only
  after the SmolVM capability preflight;
- one disposable smolvm guest per overlay job;
- prefix-scoped smolvm cleanup instead of cloud cleanup.

The default lane uses `NUKE_COUNT=20` until a fifty-way KVM qualification
passes. The workflow can be dispatched with 50 while it records host CPU/RSS,
state-directory disk usage, machine count, stage timings, responsiveness, and
cleanup. Fifty becomes the default only when all workloads finish inside the
15-minute workload deadline without violating the existing API/memory gates
or leaking machines. If fifty independent Docker daemons are the limiting
resource after disk-copy cost is gone, high-width scale remains a Tier 1 or
shared-Docker assertion rather than a reason to restore memory forks.

## CI shape

Local harness jobs run on Linux hosts with readable and writable `/dev/kvm`.
They free unused runner disk before building guest overlays, set up the runtime,
clean stale owned guests, run the provider contract or E2E, capture diagnostics,
and clean again under `if: always()`.

Diagnostics include:

- smolvm health and machine-list responses;
- service journal and serve logs;
- API/build/E2E logs;
- remaining owned machine names after failure.

The service binds only to `127.0.0.1`. Machine cleanup is limited to the
`ac-local-` prefix. Shared long-lived hosts are not assumed; hosted CI runners
are disposable.

## Tier 1: deterministic fakes

Tier 1 keeps fast model-based tests:

- `FakeCloud` for provider fan-out, preemption, retry backpressure, scheduler
  dispatch, and teardown races;
- `FakeTransport` for command-addressed SSH success and failure;
- a stateful `FakeVM` only where completion/finalization timing justifies the
  added model complexity.

Cloud-side fault scripts should model partial deletion, provider termination
ambiguity, preemption, quota-like provisioning errors, and endpoint failures.
Transport-side scripts should model sentinel, logs, exec, Docker inspection,
and bucket-sync results. Do not claim that either proves real SSH or Docker;
that is Tier 2's job.

Use fake timers or explicit barriers for concurrency assertions. Real-timer
interleaving is not a reliable concurrency oracle. Each scale regression needs
both a structural peak/order assertion and a repeated green stability check.

## Tier 3: real cloud

Provider E2E remains responsible for SDK/API behavior, credentials, catalog
selection, image compatibility, networking, quota/capacity failures,
preemption, and cleanup in AWS, Azure, GCP, Lambda, Vast, and other production
substrates.

Real-cloud nuke variants remain manual because they consume quota and wall
time. The Local 20-way nuke is the no-cloud PR gate. Neither replaces the fast
Tier 1 controller-scale suites.

## Alternatives considered

### Host Docker socket plus control containers

Rejected. It exercised the VM-host path, but required mounting the host Docker
socket into the credential-holding API container and shipping a second control
image. The socket is effectively host-root access, and the control container
still shared the host daemon with workloads. The product and test substrate are
removed together.

### Kubernetes/k3d

Kubernetes remains a useful independent provider/substrate proof. It validates
pods, sidecars, RBAC, routes, and cluster health, which is a different execution
model from production VM-host providers. Keep its contract tests, but do not use
it as the VM-host anti-drift anchor.

### Direct Docker workload execution

Rejected as the Tier 2 anchor because it turns the API into a local Docker job
executor and bypasses SSH initialization and VM-host sentinels. It would prove
the wrong runtime contract.

### In-process sshd only

Useful for focused transport tests, but insufficient as the only real anchor.
It does not prove guest boot, Docker daemon startup, image pull, workload
lifecycle, or provider cleanup.

## Risks

- Hosted runner KVM availability and smolvm release behavior can drift; pinned
  checksums, version checks, and the live provider contract make drift visible.
- A twenty-guest burst creates real memory and disk pressure; diagnostics and bounded
  workflow timeouts must distinguish saturation from orchestration regressions.
- Failed jobs can leak guests; prefix ownership, `if: always()` cleanup, and an
  age guard constrain that risk.
- Loopback mapping can accidentally take a local-shell shortcut; using
  `localhost` for the SSH host keeps the production SSH path active.
- This harness does not qualify GPUs, public ingress, or cloud networking.

## Decision

Use smolvm as the required Tier 2 VM-host test substrate. Keep Local
credentialless and capability-configured, but undocumented and absent from
public provider-selection/API-start surfaces. Exercise Jobs, Services, VMs, and
nuke through ordinary credentialless CLI submission; retain the explicit Python
SDK wire contract. Use deterministic fakes for larger scale and real-cloud E2E
for provider behavior.
