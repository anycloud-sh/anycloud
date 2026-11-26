# AnyCloud Testing Strategy

## Overview

AnyCloud uses a **hybrid testing approach** that combines:

1. **Vitest unit tests** for API service logic
2. **Constrained Vitest E2E specs** for end-to-end Workload behavior, plus a
   few retained Bash integration tests

This strategy maximizes test coverage while maintaining fast, reliable tests across all components.

## Test Structure

```
anycloud/
├── src/
├── test/
│   ├── unit/
│   │   ├── services/
│   │   ├── routes/
│   │   └── helpers/
│   └── integration/
│       ├── e2e.sh                     # Runs one E2E against an isolated API
│       ├── e2e/                       # Constrained Vitest E2E specs
│       └── helpers/
│           └── common.sh              # Shared helper functions
└── .github/
    └── workflows/
        └── integration.yml            # On-demand integration and Local smolvm CI
```

## Test Commands

| Command                                               | Description                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `yarn test`                                           | Unit tests (Vitest)                                                                  |
| `yarn test:watch`                                     | Watch mode (Vitest); selects integration specs too, never constrained E2E spec files |
| **Local Integration:**                                |                                                                                      |
| `yarn test:local-smolvm:runtime`                      | Live image, boot, SSH, init, and VM-host contracts                                   |
| `yarn test:e2e-cluster-local:vitest`                  | Cluster record and hosted chart repair on a real K3s                                 |
| **E2E:**                                              |                                                                                      |
| `test/integration/e2e.sh <name> --vitest`             | One constrained E2E spec on its own conductor (CI fans out via matrix)               |
| `test/integration/e2e.sh local-held-job --vitest`     | Internal Local Job lifecycle on disposable microVMs                                  |
| `test/integration/e2e.sh local-smolvm-vm --vitest`    | Credentialless CLI Local VM lifecycle and repair                                     |
| `test/integration/e2e.sh local-smolvm-serve --vitest` | Credentialless CLI Local Serve restart and upgrade                                   |
| `yarn test:generated-python-sdk-wire`                 | Generated Python SDK sync/async real-server contract                                 |
| `NUKE_PROVIDER=local ... e2e.sh nuke`                 | Local lifecycle/load lane; burst width is an input                                   |
| **Fake providers (RFC 0034):**                        |                                                                                      |
| `yarn test:credentials-terminal`                      | Real CLI in a PTY against fake provider CLIs and wire endpoints                      |
| `yarn test:credential-lifecycle`                      | Spawned built API against fake management planes                                     |

### Fake-provider credential lanes (RFC 0034)

Both lanes replay recorded provider behavior — personas in
`test/integration/credentials-onboarding/personas.ts`, each citing the
real-world observation or provider-published wire record it came from — over
real sockets to unmodified product binaries.
The terminal lane owns the onboarding wizard (inventory:
`credentials-onboarding/journeys.ts`). The lifecycle lane
(`test/integration/credential-lifecycle.spec.ts`, fakes under
`test/integration/fake-clouds/`) owns post-save behavior: per-provider
deploy-time validation rejection for AWS, Azure (dies at the fake Entra
token endpoint without reaching ARM), GCP (self-signed-token auth under a
universe-domain override), and Lambda, plus a green S3 bucket listing.
Lane rule: assertions stay on credential and workload state and the
user-visible error surface — never on scheduler cadence or attempt counts,
which belong to the `local`-provider tier.

### Local smolvm CI checks

The check name identifies the substrate and the behavior it proves. Each check
runs on its own runner, so one failure cannot skip another suite.

| Check                                                                                    | Command                                               | Coverage                                   |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------ |
| `local-smolvm / runtime`                                                                 | `yarn test:local-smolvm:runtime`                      | image, boot, SSH, init, and host profile   |
| `local-smolvm / job-held-vitest` (also `job-completed-vitest`, `job-resubmitted-vitest`) | `test/integration/e2e.sh local-held-job --vitest`     | Local Job lifecycle and bucket sync        |
| `local-smolvm / vm-vitest` (also `vm-host-loss-vitest`)                                  | `test/integration/e2e.sh local-smolvm-vm --vitest`    | Local VM lifecycle and repair              |
| `local-smolvm / serve-vitest`                                                            | `test/integration/e2e.sh local-smolvm-serve --vitest` | Local Service recovery, upgrade, and ports |
| `local-smolvm / nuke`                                                                    | `NUKE_PROVIDER=local test/integration/e2e.sh nuke`    | concurrent lifecycle/load                  |

The Local provider is deliberately undocumented and has no public CLI selector
or API-start flag. When no saved compute credentials or cluster exist, the CLI
leaves placement to the API, which selects Local only where its fixed loopback
SmolVM runtime is healthy. On a Linux KVM runner, prepare it before the runtime
suite or E2E:

```bash
yarn local-runtime:setup
yarn vitest run \
  test/unit/services/gateways/local.spec.ts \
  test/unit/services/gateways/smolvm-serve-client.spec.ts \
  test/unit/services/gateways/local-smolvm-cleanup.spec.ts
yarn test:local-smolvm:runtime
test/integration/e2e.sh local-held-job --vitest
test/integration/e2e.sh local-smolvm-vm --vitest
test/integration/e2e.sh local-smolvm-serve --vitest
yarn local-runtime:cleanup
```

The harness runs:

```text
test API container -> smolvm service -> COW disk overlays from a stopped .smolmachine -> cold boot -> startup script -> SSH -> initializeVM fast path -> Docker workload -> sync/status/logs/cleanup
```

Local setup creates one versioned, digest-checked stopped `.smolmachine`. Its
root disk contains the cloud-image prerequisites plus pinned Docker and rclone;
its ext4 storage disk contains Docker's `overlay2` data cluster and the fixed
`busybox:1.36` nuke image, fetched by digest through `mirror.gcr.io`. Both the
runner-side and guest Docker daemons use that Docker Hub mirror so concurrent
CI jobs do not share Docker Hub's anonymous pull quota. Before packing, setup
removes machine identity, SSH
host keys, workload keys, credentials, PID files, and sockets. Each workload
uses ordinary `machine create --from` and a fresh kernel boot; SmolVM gives it
private qcow2 disk overlays backed by immutable content-addressed bases. No
running golden, memory snapshot, fork queue, registry, runtime archive mount,
or Local curl shim is involved. SmolVM runs as the CI runner user with KVM group
access and keeps its runtime state inside that runner slot; sudo only prepares
the fixed host path and optional systemd unit.

The startup contract additionally runs one source-less bare guest through the
unchanged production vendor-download installers. That deliberately low-width
case retains installer coverage without repeating identical downloads for the
nuke. It then cold-boots two prepared-image siblings, verifies independent SSH
host and workload keys, takes the normal Docker/rclone installed fast paths,
and checks `overlay2`, `/storage/docker`, the cached workload image, and the
minimal/non-root/Docker-CLI VM profiles. The Job lane covers normal VM-host
initialization,
input/output/checkpoint syncing
through the shared storage path, image pull, secrets, Docker options,
exec/logs, completion monitoring, termination, same-ID resubmit, and microVM
cleanup. The dedicated Serve lane adds mapped guest TCP/80, a hard API restart
while the workload is still `Starting`, adoption of the same VM and guest
container, replacement upgrade, null URL/DNS assertions, and closure of every
forwarded port. Neither lane mounts the runner's Docker socket into the API.
This is distinct from `yarn test:e2e-cluster-local:vitest`, which checks the
cluster record and hosted chart repair against a real K3s on Docker.

`local-smolvm / nuke` requires at least 300 overlay Jobs plus a second caller's
witness cohort, with at most 50 concurrent submission processes. Every Job gets a
real independent cold-booted microVM from the prepared image. Docker and rclone
are already installed, but every VM still receives the shared startup script,
workload identity, SSH lifecycle, Docker daemon startup, scheduler work, and
cleanup. `.github/workflows/nuke.yml` owns this job; Integration calls that
reusable workflow with the PR gate inputs rather than maintaining another setup,
sampling, or cleanup path.

Machine shape and deadlines are fixed in the gateway, not configurable: one
CPU, 512 MB, and 4 GB each of overlay and storage. CPU and memory values are
guest safety ceilings, not host reservations. Each Local gateway constructs a
runtime interface containing the fixed endpoint, sidecar, SSH host, shape, and
deadlines. It reads no environment configuration, so the setup script, API
container, and provider cannot silently drift when a forwarding line is
omitted. `IS_TEST` remains limited to unrelated test authentication and
diagnostics.

The local contracts validate the provider-neutral behavior Anycloud owns:
startup-script contents, SSH, VM initialization, Docker/rclone, syncing, and
workload execution. They do not emulate native cloud-init/user-data delivery,
instance IAM/metadata, provider networking, spot signals, or the systemd state
of real cloud images. The real-cloud lanes retain those responsibilities; the
retired Docker vmstartup fixture did not cover them either.

The disk operation is metadata-scale even though each VM cold-boots: the first
create normalizes each packed sparse disk once into a read-only base, and every
later create receives tiny private qcow2 overlays. This preserves cloud-like
independent boot behavior without copying multi-gigabyte disks or restoring
another VM's memory state.

The default remains twenty until the explicit fifty-way `ubuntu-24.04` KVM
qualification passes. A dispatch can select fifty while host CPU/RSS, disk,
machine count, create/start/startup-script and Docker-daemon timings, API
responsiveness, the 15-minute workload deadline, and cleanup are recorded.
Timestamped initializer start/completion logs retain its total wall time. If the
limiting factor is fifty independent `dockerd` processes rather than disk
creation, the high-width assertion belongs in FakeCloud/shared-Docker
simulation; memory forking is not a fallback.

Persistent-VM host-loss coverage deletes a second VM directly in every Local
and real-cloud VM lane, then asserts `Failed`, cleanup, the ended original row,
the `/workspace` loss reason, and no replacement row.

The manually dispatched `E2E GPU Qualification` workflow runs AWS, Azure, and
Lambda in parallel. Each provider first runs a GPU serve/passthrough smoke, then
runs the same pinned MACE image through a full pull and first CUDA inference.
Within a provider those checks are sequential; successful containerd transfer
and explicit successful Docker fallback are both valid delivery outcomes.

## Vitest Tests (API Service)

**Purpose:** Unit test API service business logic

**Coverage:**

- ✅ DNS record parsing and management
- ✅ API token encryption/decryption
- ✅ Cloud configuration handling
- ✅ API routes and middleware
- ✅ Cloud provider gateways (AWS, Azure, GCP)

**Files:**

Located in `test/unit/` directory:

- `routes/` - API endpoint tests
- `services/` - Service logic tests
- `middleware/` - Express middleware tests
- `daemon/` - Daemon functionality tests
- `shared/` - Shared utilities tests

**Configuration:**

- `vitest.config.mts` - Vitest configuration
- `test/unit/setup.ts` - Global test setup (GitHub mocking)
- Node test environment
- 30s test timeout for workload operations

### Published-catalog contract

`test/global-setup.ts` downloads the published provider catalogs before Vitest
runs. Tests of catalog semantics and product behavior—including GPU resolution,
region/zone placement, optimization, pricing, and quota-family lookup—must query
those parsed catalogs directly. They must not replace `readCatalog()` or
placement queries with a synthetic topology. This keeps AWS, Azure, GCP, and
Lambda coverage on the same production data path and makes provider catalog
changes visible to the tests.

Raw provider-response samples and generated CSV entries belong only in catalog
mechanics specs that directly test parsing, provider normalization, cache I/O,
or serialization. A catalog-unavailable test may explicitly make
`readCatalog()` return `undefined`; it must not invent catalog contents.

`yarn check:catalog-test-boundaries` enforces this split, and
`yarn check:boundaries` includes that check.

**Running:**

```bash
yarn test              # Run all unit tests
yarn test:watch        # Watch mode; constrained E2E members never run here
```

## GitHub Actions CI/CD

The repository Actions variable `CI_BACKEND` routes every job except Release,
which always runs on GitHub-hosted runners (`ubuntu-latest`, plus
`ubuntu-24.04-arm` for its ARM64 image). Release is the recovery path: it must
run while backmesh is down, like backmesh's own release and CI install. What it
only triggers follows `CI_BACKEND`: the skill publish, the install-script and
docs deploys and the artifact cleanup after it wait for backmesh, and GitHub
fails them after 24 hours queued. Integration runs on every pull request.

| Value             | Runner                                          |
| ----------------- | ----------------------------------------------- |
| unset, `backmesh` | Each job's backmesh label                       |
| `hosted`          | Each job's original GitHub-hosted Ubuntu runner |

Every other `runs-on` has the same shape, with the job's hosted runner and
backmesh label (Release's artifact cleanup also takes `inputs.hosted`):

```yaml
runs-on: ${{ vars.CI_BACKEND == 'hosted' && 'ubuntu-latest' || 'backmesh-ubuntu-2404-4vcpu' }}
```

backmesh runs one job per ephemeral runner. Jobs run on `backmesh-ubuntu-2404-4vcpu` (4 vCPU,
15.5 GiB) unless they need another size:

- `backmesh-ubuntu-2404-2vcpu`: Slack notifications, artifact cleanup, the E2E post-cleanups,
  the GPU service-native audit, the Lambda boot failover's cleanup audit, the
  managed GPU recovery's Azure readback, Mutant Survivors' comment and the
  agent workflows' bookkeeping jobs.
- `backmesh-ubuntu-2404-8vcpu`: the claim burst and the deps base build.
- `backmesh-ubuntu-2404-od-4vcpu`, on demand: the multi-hour dispatch jobs (API Performance
  compare, Mutant Parity, E2E Cluster Tests, the Lambda boot failover trials,
  managed GPU recovery and cloud nukes), where a spot reclaim would cost more
  than on demand.
- `backmesh-ubuntu-2404-od-8vcpu`, on demand: the K3s local clusters, which run 46–54 minutes on
  the release path.
- `backmesh-ubuntu-2404-kvm-4vcpu`, with `/dev/kvm`: Local SmolVM.
- `backmesh-ubuntu-2404-kvm-16vcpu`, with `/dev/kvm`: the local nuke, whose 300 microVMs ran in
  8 minutes there and ran out of capacity on `backmesh-ubuntu-2404-kvm-4vcpu`.

`BACKMESH_LABELS` in `test/unit/scripts/ci-backend-workflow.spec.ts` pins each
label. backmesh retries a run whose only failures were spot reclaims, on
demand, once the run finishes.

Jobs that read a repository secret other than `GITHUB_TOKEN`, or whose token
can write, run on backmesh like the rest: each job gets its own VM, so no other
job shares its runner (owner, 2026-11-08).

backmesh's image has Docker, the Actions runner, kubectl and GitHub's apt
toolset; it installs the AWS, Azure and Google Cloud CLIs on first use.
`scripts/ci-install-dependencies.sh` enables Yarn through setup-node's Corepack
and installs the OpenSSH client and Python pip and venv where they are missing.
There's no Yarn or Buildx cache on backmesh, and each job starts with an empty
`actions/setup-*` tool cache.

Fork and Dependabot pull requests never reach backmesh: their jobs are skipped,
and Style runs them on GitHub-hosted runners.

```bash
# All of CI on backmesh
gh variable set CI_BACKEND --repo anycloud-sh/anycloud --body backmesh
# GitHub-hosted runners
gh variable set CI_BACKEND --repo anycloud-sh/anycloud --body hosted
```

A change applies to newly queued jobs. `.github/actions/ci-backend` rejects any
other value.

Workflow concurrency cancels an older run for the same workflow/ref.

## Test Coverage Matrix

| Component       | Test Type | Status      | Confidence |
| --------------- | --------- | ----------- | ---------- |
| **API**         |
| DNS management  | Vitest    | ✅ PASS     | 100%       |
| API tokens      | Vitest    | ✅ PASS     | 100%       |
| Cloud config    | Vitest    | ✅ PASS     | 100%       |
| API routes      | Vitest    | ✅ PASS     | 100%       |
| Cloud gateways  | Vitest    | ✅ PASS     | 100%       |
| **Daemon**      |
| DNS discovery   | Manual    | ⚠️ UNTESTED | Low        |
| Leader election | Manual    | ⚠️ UNTESTED | Low        |
| Auto-scaling    | Manual    | ⚠️ UNTESTED | Low        |

## What's Not Tested (Yet)

### Requires Multi-VM Setup

- DNS-based VM discovery via Cloudflare TXT records
- Leader election with LogRendezvousHash algorithm
- Inter-VM communication
- Workload failover

### Requires API Integration

- Full E2E workload flow
- VM creation with daemon installation
- Startup script execution
- API token validation
- Heartbeat to `/v1/ack`
- Auto-scaling triggers to `/v1/scale`

### Requires Load Testing

- High CPU/memory scenarios
- Auto-scaling thresholds (30%, 80%)
- Container crash recovery
- Network partition handling

## Adding New Tests

### Adding Vitest Tests (API)

1. Create `*.spec.ts` file in appropriate `test/unit/` subdirectory
2. Import from Vitest: `import { describe, it, expect, vi } from 'vitest'`
3. Write test cases with `test()` or `describe()/it()`
4. Run with `yarn test`

Example:

```typescript
// test/unit/services/my-feature.spec.ts
import { describe, it, expect } from 'vitest';
import { MyFeature } from '../../../src/api/services/my-feature';

describe('MyFeature', () => {
  it('should do something', () => {
    const feature = new MyFeature();
    expect(feature.doSomething()).toBe(true);
  });
});
```

## Debugging Failed Tests

### Vitest Tests

```bash
# Run specific test file
yarn vitest run test/unit/services/dns.spec.ts

# Run with verbose output
yarn vitest run --reporter=verbose

# Run in watch mode
yarn test:watch
```

## Future Improvements

1. **Upgrade Jest/ts-jest** when Node.js 22 support is stable
2. **Add E2E tests** with real cloud workloads
3. **Add performance tests** for metrics collection
4. **Add stress tests** for auto-scaling
5. **Add security tests** for authentication edge cases
6. **Mock Cloudflare API** for DNS tests
7. **Add contract tests** between daemon and API

## Recommendations

### For Contributors

- ✅ Run `yarn test:all` before committing
- ✅ Add tests for new features
- ✅ Document test requirements in comments

### For CI/CD

- ✅ GitHub Actions workflow is configured correctly
- ✅ Unit and style checks run on code PRs; integration and E2E suites run on demand
- ✅ Test logs uploaded as artifacts for debugging
- ⚠️ Consider adding code coverage reporting

### For Production

- ⚠️ Run full E2E tests with real VMs before major releases
- ⚠️ Test auto-scaling under load
- ⚠️ Verify DNS discovery with real Cloudflare setup
- ⚠️ Test leader election with 3+ VMs

---

# Proposal: Swappable Transport + Deterministic Scale Simulation

> Status: **Phase 0a + Phase 1 core implemented** (uncommitted working tree) — the transport seam plus a shared
> `FakeTransport` adopted in the spec files where it pays off. Phase 0b, the
> remaining Phase 1 files, and Phases 2–3 are proposal. Motivation: most
> production bugs surface only at production scale (1000s of jobs) and are
> concurrency / timing / cloud-fault bugs that we currently cannot reproduce
> except against real clouds. This section is the concrete plan to make those
> testable in-process.

## The problem this fixes: the SSH transport was not injectable

Every real action AnyCloud takes happens **over SSH** — `docker pull/run/inspect`,
`rclone`, `systemctl`, sentinel polling, detached runs. `SSHManager` _was_
constructed inline at **~10 call sites** (`conduct.ts` ×7, `docker.ts`,
`gateways/vast.ts`, `routes/cli.ts`, plus implicit construction inside
`DockerManager`), with **no factory** the way `createComputeProvider`
(`cloud-config.ts`) is a factory for cloud gateways — so there was no seam to swap
a fake transport behind.

> ✅ **Resolved by Phase 0a** (shipped): `VmTransport` + `createTransport()` now
> wrap every construction site, so a fake can be injected behind the interface.
> The test cruft below still exists — it is **Phase 1's cleanup target**, now
> unblocked.

| Symptom                                                                      | Where                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The same ad-hoc SSH stub re-declared in ≥5 files                             | `vi.mock('…/gateways/ssh')` in `conduct.spec.ts`, `docker.spec.ts`, `new.spec.ts`                                                                                                                        |
| Mocks coupled to call **order**, not VM state                                | `conduct.spec.ts`'s `mockDockerExited` (`docker inspect`→`docker logs`, now fixed). NB: `docker.spec.ts`'s deeper `mockResolvedValueOnce` chains are mostly the local-`execSync` path, not the transport |
| Interface drift — stubs return `{stdout,stderr}` with no `code`              | `conduct.spec.ts` (real `exec` returns `{code,stdout,stderr}`)                                                                                                                                           |
| Private static pool poked via bracket-notation to reset/inspect global state | `SSHManager['connectionPool']` bracket pokes ×19 in `gateways/ssh.spec.ts`                                                                                                                               |
| Job-completion path (SSH → `docker inspect` → terminate) **untested**        | `monitor.spec.ts` does `vi.mock('…/docker')` wholesale to stop real SSH                                                                                                                                  |

## What the leading OSS peers do (verified against source, 2026-06)

|                                                | SkyPilot                                                                                                                            | dstack                                                                                                                                                                                        | This proposal                                  |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Production transport abstraction               | ✅ `CommandRunner` base + `SSHCommandRunner`/`KubernetesCommandRunner`/`LocalProcessCommandRunner` (multi-substrate prod, not test) | ⚠️ `Compute(ABC)` abstracts **provisioning**; **no** command-runner abstraction — SSH is the single universal transport (HTTP-over-SSH-tunnel; k8s uses an sshd jump-pod, not `kubectl exec`) | `VmTransport` interface, built _for_ injection |
| Purpose-built fake transport behind it         | ❌ generic `unittest.mock`                                                                                                          | ❌ generic `unittest.mock`; `ComputeMockSpec` is an isinstance-shell                                                                                                                          | ✅ stateful `FakeVM`                           |
| Deterministic in-process scale / virtual clock | ❌ (`_FakeClock` drives one k8s loop only)                                                                                          | ❌ (freezegun for single timeouts only)                                                                                                                                                       | ✅ the novel bet                               |
| How the real SSH path is actually validated    | **Real substrate**: `tests/smoke_tests` on real AWS/Azure + a local `kind` cluster                                                  | Mostly **in-process mock-at-boundary** (suite runs socket-disabled); real Docker only in Go agent tests, gated off in CI                                                                      | real-sshd gate (Phase 3) + real cloud          |

Takeaways that shape the plan:

1. **The interface refactor is industry-standard** — both mature peers have a clean
   transport/provision seam. Extracting `VmTransport` is not exotic.
2. **The purpose-built stateful fake + virtual-clock scale sim is _not_ something
   either peer built.** Treat Phase 2 as a deliberate bet, not a foregone
   conclusion — its payoff is capped by model fidelity (Phase 3 anchors it).
3. **Real substrate is everyone's confidence mechanism for the SSH path.**
   SkyPilot's local `kind` cluster ≈ our Phase 3. Don't expect a fake to replace it.
4. **Steal-worthy:** SkyPilot's `MockSSHServer(paramiko.ServerInterface)` is an
   in-process _real_ sshd on a loopback socket that the _unmocked_ SSH client
   connects to — a lighter version of our `ssh-keepalive.spec.ts` Docker test.

## Already a seam (do NOT rebuild)

- **VM transport** — `VmTransport` + `createTransport()` (`gateways/transport.ts`),
  shipped in Phase 0a. A fake transport implements this one interface.
- **Cloud provider factory** — `PROVIDER_IMPL` registry + `createComputeProvider()`
  (`cloud-config.ts`). A `FakeCloud` is one registry entry.
- **DB** — already `:memory:`-capable via `SQLITE_PATH` (`repositories/db.ts`).
- **Reconciliation entry point** — `runWorkloadReconcileOnce()` drives the
  same discovery, preflight, fair admission, and handlers as the live
  controller. Independent periodic services retain focused `run*Once()` entry
  points; `createMonitor` is only their non-overlapping `setTimeout` wrapper.
- **`runDetachedOnVm`** already takes a `VmExecFn` callback (`vm-exec.ts`).

## Target: test tiers

```
Tier 0  pure          plain value→value fns (no fake, no clock)                →  decision correctness: disposition / recovery-path / backoff / alert-dedup truth tables
Tier 1  unit          FakeTransport + FakeVM (virtual clock)   →  logic, state-machine, retry/teardown storms, 1000s of jobs, deterministic
Tier 2  substrate     real sshd (in-process paramiko / kind-style container) + stub docker/rclone shims  →  real pool/keepalive/sockets + real command strings
Tier 3  real cloud    existing e2e/*.sh, smoke matrix          →  emergent cloud timing (the residual)
```

## Tier 0 — pure decision functions (proposed; orthogonal to the transport/scale axis)

> Status: **audited — the decisions are already covered.** Tiers 1–3 target
> concurrency / timing / state-machine. They do **not** cover _decision correctness_ — the
> pure truth-tables the orchestrator branches on, testable as plain value→value units with
> **no fake, no transport, no clock**, the way `rclone-config.ts` already is. But a coverage
> audit found the codebase already tests these via focused conduct, monitor, and
> spend-controls specs rather than heavy integration.

The pattern already exists: `resolveProvisioningFailureDisposition` (`provisioning-failure.ts`) is a
pure disposition mapper unit-tested in `provisioning-failure.spec.ts`. Audit of the candidate decisions:

| Decision                                        | Verdict                   | Evidence / note                                                                                                                                                      |
| ----------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| s3 least-privilege (`aws.ts:238`)               | already covered           | `aws-storage-creds.spec.ts:141-161` asserts read→no Put/Delete via `mintScopedStorageToken` (STS mocked) — a direct export adds nothing                              |
| notify-dedup gate (`monitor.ts:1073`)           | already covered           | `monitor.spec.ts:1677` ("dedups repeated Queued block resolutions")                                                                                                  |
| retry backoff (`retry-backoff.ts` + reconciler) | covered integration-style | tests pin each state-based window, one sample per durable revision, immediate preparation, delayed launch, restart resampling bounds, and exact-revision queue claim |
| recovery-path (`monitor.ts:231-243`)            | cut                       | the dangerous part (call `startVM` only in Running, then branch) is call-ordering that stays in the imperative shell; a pure path-table doesn't pin it               |

Also out of scope (bare comparisons, no bug surface): job-timeout `>=`,
throttle/budget thresholds.

**Honest scope:** Tier 0 pins _what the right decision is given inputs_ — it cannot catch
the orchestration _around_ the decision (call ordering, teardown race, fan-out bounds),
which is exactly what Tiers 1–3 own.

## Phased plan

### Phase 0a — Transport seam ✅ DONE (pure DI, no behavior change) ← keystone

Shipped in `src/api/services/gateways/transport.ts`:

- `VmTransport` exposes command execution, stdin-backed file writes, and reachability checks — exactly the instance surface callers use. Static key-gen / teardown (`generateKeypair`, `derivePublicKey`, `closeConnection`) stay on `SSHManager`, so `close()` is intentionally **not** on the interface.
- `createTransport(host, key, port?, username?)`, mirroring `createComputeProvider`; default impl = real `SSHManager`, which now `implements VmTransport` (drift guard).
- All **10** `new SSHManager(...)` sites routed through it (`conduct.ts` ×7, `docker.ts`, `gateways/vast.ts`, `routes/cli.ts`). **7** consumer signatures retyped `SSHManager` → `VmTransport` (`vm-initializer.ts` ×5 incl. `hasSystemd`/`initializeVM`, `supervisor.ts` ctor, `docker.ts` field).
- Verified: `tsc --noEmit` clean (tsconfig gates `src/**` only — the test tree, incl. `mock-transport.ts`, isn't tsc-checked, just vitest-run); full unit suite (2420 tests) green; one assertion updated (`vast.spec.ts` arg count, since `createTransport` forwards a defaulted `username` slot).

Note: the duplicated `vi.mock('…/ssh')` cleanup is **not** part of 0a — the seam exists, but deleting the test cruft happens in Phase 1.

### Phase 0b — Pool + local-path cleanup (deferred, behavior-affecting)

- Add `SSHManager.disposeAll()` and make the connection pool ownable/resettable (kills the `['connectionPool']` bracket pokes). Deferred because the static pool is load-bearing at scale (Jun-2026 incident) — a separate, riskier change than the DI seam.
- Fold the `isLocal` / `127.0.0.1` `execSync` branch in `DockerManager` into a transport impl, so there is **one** SSH path. Behavior-affecting, hence separate from 0a.

### Phase 1 — Shared `FakeTransport` ✅ CORE SHIPPED (Tier 1 unit)

Shipped `test/unit/helpers/mock-transport.ts`: `createFakeTransport()` returns a `FakeTransport extends VmTransport` that is **command-addressed** (`.on(pattern, resp)` / `.default()`), not order-addressed. `exec`/`ping` are real `vi.fn()`s so existing `toHaveBeenCalledWith` / `mock.calls[i]` assertions survive verbatim, and a `normalize()` step fills the missing `code` field (closing the interface drift). Tests mock the `transport.ts` seam (not `ssh.ts`), so SSHManager statics stay real.

Adopted where it's a genuine win (full unit suite green, 2420 tests):

- `conduct.spec.ts` — `mockDockerExited`'s two `mockResolvedValueOnce` → command-addressed `on('docker inspect')`/`on('docker logs')`; all 24 `sshExecMock` refs repointed to the shared fake. 48/48 pass.
- `status-vast.spec.ts` — bespoke ssh mock → shared fake (its zero-config default = `{ stdout: '', code: 0 }`, ping → true).

Deliberately **not** migrated — analysis showed lateral or impossible, no bug prevented (avoid churn):

- `deploy.spec.ts` — single constant exec response entangled with its `deployFlowMocks` hoisted bundle; migrating splits one clean mock into two for ~zero gain.
- `new.spec.ts` — statics-only (`generateKeypair`); no exec/ping surface.
- `docker.spec.ts` — its deep `mockResolvedValueOnce` chains are mostly the local-`execSync` path that never reaches the transport; only its remote suites could move (low marginal value).

### Phase 1b — Reconciler → SSH re-enable (deferred, separate PR)

Dropping `monitor.spec.ts`'s wholesale `vi.mock('…/docker')` to run the real `DockerManager` against the `FakeTransport` requires un-mocking `workload-workflows/completion` (keep `checkJobCompletion`/`finalizeJobArtifacts` real) and rewriting ~8 tests' mocking model (today they no-op `completion.checkJobCompletion`/`finalizeJobArtifacts` wholesale, so the container health/status path is never exercised). Substantial enough to warrant its own PR now that the `FakeTransport` exists.

### Phase 2a — Cloud-only scale: `FakeCloud` (Tier 1 scale) — lead here, ungated

The reconciliation paths whose hazard is a _cloud-gateway_ fan-out, not SSH —
preemption (the worked example in the Tier-1 recipe below), retry backpressure,
teardown-leak, and scheduler dispatch. These are the meltdown legs (fan-out blowup, retry storm,
teardown race) and the cheapest path to the motivating value. **Calibration:**
preemption-path fan-out is shipped + proven (`preemption-scale.spec.ts`), and
the production workload-state controller path is now covered by
`workload-reconcile-scale.spec.ts` at 2x peak production load with aggregate in-flight
<= 40. Both are driven under **fake timers** so the measurement is deterministic.
Provider-specific retry/teardown fault modeling still belongs here as 2a work,
but the runtime eligibility path is no longer only intent.

- `FakeCloud`: returns a branded `CloudCompute` + `Preemptible` from `makeMockCloudCompute` (plus a concurrency meter; intercept `createComputeProvider` via `vi.mock` + `vi.mocked` (recipe step 3), or a `PROVIDER_IMPL` entry). **No transport, no `FakeVM`.** Add **scriptable cloud-side faults** — NIC-abort mid-exec, DB-`terminated`-before-cloud-delete, `terminateVMs` partial failure. The exit codes `{100,2,7}` and connect-drop are SSH/docker faults read over SSH — they belong to Phase 2b's `FakeVM`, not the cloud-only bucket.
- Virtual clock via `vitest.useFakeTimers()` to drive reconciler deadlines and retry backoff deterministically. Build a `clock` abstraction **only if** fake-timers proves insufficient against sync `better-sqlite3`.
- Drive N workloads + reconciler turns; assert no retry storm / teardown leak / fan-out blowup. Each lands its fix-by-test (bound the fan-out with shared admission, add per-provider backpressure).

### Phase 2b — SSH-bound scale: stateful `FakeVM` (Tier 1 scale) ← the bet

The reconciler paths that read state over SSH (job completion and finalization). Rides
Phase 1's `VmTransport` seam shape — but the shipped `FakeTransport` is **stateless**; the FakeVM is a net-new **clock-driven state interpreter** on top (the same `docker inspect` must return running→exited-with-code over the virtual clock; sentinel files have state). This is the bulk of the build, not a thin extension.

- `FakeVM`: a tiny in-memory model of the command→state contract — docker lifecycle (`run`→`inspect` exit code on a clock), sentinel files (`/tmp/<unit>.done`), `systemctl is-active`, detached runs — answering the ~20 distinct commands the orchestrator branches on. `FakeCloud`'s faults (2a) layer on here for the SSH-path races.
- **Honest limit:** catches concurrency/timing/state-machine bugs; does **not** validate command strings (Phase 3) or emergent cloud timing (Tier 3).
- **Efficacy gate (distinct from the Sequencing gate):** Sequencing asks _is there enough SSH-bound residual to bother?_ (volume); this asks _would the `FakeVM` as specified actually reproduce it?_ (fidelity) — and the two can disagree. 2b is the biggest build on the least-validated claim, and Phase 1 showed value claims here run hot until read closely. Before building, replay 2–3 genuinely **SSH-path** incidents on paper — the `docker pull` NAT/idle-teardown that motivated `runDetachedOnVm` (held-open exec dies; the sentinel poll must survive it), a job-completion `docker inspect` exit-code flap that mis-terminates, and finalization's rclone-over-SSH command contract. The unified in-memory controller now bounds admission to these SSH checks; `FakeVM` is about command fidelity and state timing, not adding another cap. Does the modeled command→state contract reproduce each _deterministically_? If it needs hand-waving, the fidelity isn't there — narrow or defer. (NB: the Jun-2026 heap/retry leg and the DB-`terminated`-before-cloud-delete teardown race are **cloud-gateway** failures — they belong to Phase 2a / `FakeCloud`, which the FakeVM cannot and should not model.)

### Phase 3 — Real-substrate SSH gate (Tier 2)

This "Phase 3" belongs to the **test strategy**: it is the real-SSH substrate
anchor for the FakeTransport/FakeVM testing stack. It is separate from SLAC's
runtime **unified in-memory controller** work, which collapses workload-state
monitors onto one aggregate process-local admission budget while SQLite remains
authoritative.

- The Local Job (`local-held-job`, `local-completed-job`, `local-resubmitted-job`),
  `local-smolvm-vm`, and `local-smolvm-serve` Vitest E2Es are the
  real-substrate anchors. They boot disposable Linux microVMs, connect through
  the production SSH transport, start the real Docker daemon and workload, and
  exercise Job completion, VM repair, Service ingress/recovery/upgrade,
  termination, and cleanup. Do not stub Docker in these lanes.
- This validates the real OpenSSH handshake, multiplexing/keepalive, and literal
  command strings—the things the FakeVM models but cannot prove.
- `ssh-starvation.spec.ts` fills a stock sshd connection with ten indefinite user
  streams, proves platform work remains responsive on its separate master, and
  covers admission, cancellation, stale sockets, independent master recovery,
  bootstrap coalescing, and teardown without raising guest sshd limits.

## Sequencing

Phase 0a + the Phase 1 core are **done** — the seam and the shared `FakeTransport`
exist and are adopted where they pay off. Remaining pieces are small and
independent: Phase 0b (pool / local-path), Phase 1b (reconciler→SSH re-enable), and
Phase 3 (real-substrate gate). Cheapest, ungated leads: **Tier 0** (pure
decisions) and **Phase 2a** (cloud-only scale — the meltdown legs, `FakeCloud`
only). **Phase 2b** (`FakeVM`, SSH-bound scale) is the differentiated bet — and
landing 2a first makes its gate _real_: after 2a + Tier 0, is the residual
production-class risk concentrated enough in the **SSH-bound** reconciliation paths to justify
the `FakeVM` fidelity build?

## Concurrency caps & backpressure

The residual fan-out caps, per-operation-class sizing, unified in-memory
controller, weighted fairness, reconstructible retry timing, heap target, and
what is **gated on measurement** live in **[`../SLAC.md`](../SLAC.md)** (Scale,
Latency & Concurrency) — the design rationale for the numbers and runtime
concurrency model. This doc is the scale-test _harness_ that verifies those
bounds (see the recipe below).

### Coverage after the legacy batch-wrapper removal

Removing the seven workload batch wrappers does not remove their domain
coverage; it moves the test entry point to the production ownership boundary:

- `workload-reconciler.spec.ts` owns controller mechanics: discovery,
  scheduling, work-kind selection, retry preparation/launch timing, stale
  preflight, per-ID serialization, fairness, explicit cleanup, outcomes, and
  failure isolation.
- `monitor.spec.ts` seeds durable states and calls
  `runWorkloadReconcileOnce()`, so preemption, completion, finalization,
  retry, cleanup, and active-pipeline recovery are still tested through their real
  dispatcher and state-transition guards.
- `workload-reconcile-scale.spec.ts` proves the aggregate mixed-lane cap and
  fairness. The preemption and job-completion scale specs enter through the same
  controller while isolating each path's latency model.
- `repositories/workload-queries.spec.ts` owns candidate selection/query plans
  and `repositories/workload-lifecycle.spec.ts` exact-revision claims; `vm-provisioner.spec.ts` owns the pre-mutation attempt
  ledger and provider-ID retargeting invariant.

Wrapper-only tests for duplicate outer fan-out caps were intentionally removed:
the wrapper and those caps no longer exist. Their safety property is stronger
and covered once at the shared controller (`peakTotal <= K`), while the domain
assertions remain on the unified path.

## Tier-3 production-shaped nuke replay

The deterministic Tier-1 scale tests prove the controller path's aggregate
in-flight cap and modeled drain time. The opt-in nuke lane is the real-substrate
incident replay:

- `yarn test:long-history-responsiveness:vitest` seeds a large
  production-shaped `nuke-db` fixture and checks API/list/status/monitor-query
  responsiveness without touching cloud providers.
- `./test/integration/e2e.sh nuke` seeds the same historical shape, launches a
  bounded real-cloud overlay (`NUKE_COUNT`, default and minimum 300) through the full
  lifecycle, keeps the responsiveness probes running, scans API logs for
  crash/OOM/fatal-SQLite signatures, and gates completion percentage.
- `nuke.test.sh` also samples the API's test-only `/__test/memory` endpoint during
  the run, writes `$RESULTS_DIR/nuke-api-memory.ndjson`, and fails on configured
  max RSS, max V8 heap, post-warmup RSS slope, or post-warmup heap slope
  regressions. The heap slope fails only over a post-warmup window of at least
  55 s and 5 samples; shorter or sparser windows report it as a warning.
  Isolated sampler curl failures are reported as warnings; sustained sampler
  failure still fails the lane because it means the API was not reliably
  responsive to a cheap test endpoint.
- Every provider and count also writes `$RESULTS_DIR/nuke-host.ndjson` and
  `nuke-host-report.json`. These structured samples record API-container process,
  file-descriptor, and socket counts plus runner load and available memory.
  They do not inspect transport commands or retain secrets. Local runs add peak
  microVM and runtime-disk fields. Missing usable host samples fail the lane.

The Local smolvm variant runs on demand with no cloud spend. Real-cloud variants
remain manual/opt-in because they burn quota and wall time. Neither variant
replaces the fast Tier-1 scale tests; they close the residual that fake time
cannot prove: real API RSS/heap behavior while a large seeded history and a real
execution overlay are active.

Quota/capacity exhaustion is an expected real-substrate failure mode for this
lane. The June 2026 production failures were confirmed Azure
`OperationNotAllowed` / `LowPriorityCores` quota errors; a nuke pass-bar failure
is compatible with the same class of issue, but retained workflow metadata alone
may not prove quota was the cause for a specific historical run.

## Tier-1 recipe: writing a fake-cloud scale / orchestration test

> Status: Tier-1 coverage now includes the preemption path
> (`test/unit/services/preemption-scale.spec.ts`) and the unified production
> workload-state controller path
> (`test/unit/services/workload-reconcile-scale.spec.ts`).
> Preemption deliberately needs **no transport seam**: it only calls the cloud
> gateway (`verifyVMPreemption`/`startVM`), never SSH, so `FakeCloud` alone
> suffices. The SSH-based reconciliation paths (job completion and finalization) ride the Phase-0
> `VmTransport`
> seam before they get the same treatment.

**Two lanes — pick by what you're testing:**

- **Gateway SDK behavior** (does our AWS/Azure/GCP code speak the SDK correctly?)
  → real-cloud integration (`*-happy` / `*-sad` / `e2e.sh`).
- **Orchestration / monitor logic** (ordering, retries, teardown, fan-out at
  scale) → **fast fake-cloud unit test**, this recipe. No real cloud, < 1s.

> **Determinism is a measured property, not a label.** Measure peak concurrency /
> ordering **structurally** — under `vi.useFakeTimers()` (+ `await
vi.runAllTimersAsync()`) or an explicit barrier — **never** via real-timer
> (`setTimeout(0)`) macrotask interleaving, which flaps under cold-start/GC load.
> "Catches the bug when present" (RED→GREEN) and "never falsely reds" are
> _separate_ properties; a scale test isn't "proven" until it's green across
> repeated cold runs (or deterministic by construction). (This rule is why the
> meter holds are driven by fake timers in step 4 — an earlier real-timer version
> over-counted `peak=N` on a cold run.)

> **Fairness is separate from aggregate safety.** A green `peak <= K` test only
> proves the reconciler cannot fan out past the shared budget. It does not prove
> every arm makes progress when another arm is saturated. Unified reconcile tests
> must also cover a saturated high-volume running-job backlog plus due
> retry/finalization/cleanup/active-recovery rows, and assert the low-volume arms
> still advance while the polling lane remains saturated.

> **Immediate bootstrap inspection is separate from normal age-based active
> recovery.** Bootstrap discovery makes persisted active rows immediately due
> for the same fact-based recovery handler; it does not record or infer which
> process previously owned the work. Regression coverage seeds all 50 admitted
> active pipelines behind unresolved workload promises and proves the
> reconciler hands off every ID, continues polling other work, and does not
> duplicate a workload on rediscovery. The long-running promises are outside
> the reconciler's fixed `K=40` in-flight bound.

**Recipe** (worked example: `test/unit/services/preemption-scale.spec.ts`):

1. **Seed** the `:memory:` store with what the tick enumerates —
   `seedSpotWorkloads(n)` (`test/unit/helpers/seed.ts`), which calls
   `createWorkload(getDB(), …)` and the `provisionTestVm` and `walkToState`
   helpers, with one shared real (decryptable) `TEST_GCP_CRED` so
   the _real_ `loadWorkloadConfigs` resolves it. Reset with
   `resetTestStore()`.
2. **Build the fake** from `makeMockCloudCompute(overrides)`
   (`test/unit/helpers/fixtures.ts`) — it already returns branded
   `CloudCompute & Preemptible`. Wrap the method under test with the
   **concurrency meter** (`test/unit/helpers/concurrency-meter.ts`) to record
   peak in-flight calls.
3. **Inject it** by `vi.mock`-ing the factory module — `vi.mock('…/cloud-config', …)`
   then `vi.mocked(createComputeProvider).mockReturnValue(fake)` (also stub
   `buildCloudConfig`), the `monitor.spec.ts` pattern. **Not** `vi.spyOn` on the
   named export — the SUT imports `createComputeProvider` directly, so a spy is
   invisible to it and the real provider runs. **Leave `loadWorkloadConfigs` real**.
4. **Drive the real controller entry point under fake timers** (per the
   determinism rule):
   `vi.useFakeTimers(); const tick = runWorkloadReconcileOnce(); await vi.runAllTimersAsync(); await tick;` (then `vi.useRealTimers()`). **Assert the bound**:
   `expect(meter.peak('verifyVMPreemption')).toBeLessThanOrEqual(CAP)`.
   Unbounded fan-out → red; `pAllSettledLimit` → green.

`makeMockCloudCompute` + the seed helpers are the canonical primitives — prefer
them over re-declaring ad-hoc cloud stubs inline.
