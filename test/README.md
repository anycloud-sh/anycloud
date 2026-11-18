# Testing Guide

> **📖 For comprehensive testing documentation, see [STRATEGY.md](./STRATEGY.md)**

## Quick Start

### Run All Tests

```bash
# Build first
yarn build

# Run everything
yarn test:all
```

### Run Specific Tests

```bash
yarn test                    # Unit tests only (Vitest)
yarn test:e2e                # E2E API service test
yarn test:integration        # All integration tests
```

The opt-in [mutation harness pilot](mutation/README.md) runs with
`yarn test:mutation:harness`. It measures assertion effectiveness in six selected
E2E harness modules using six unit suites; ordinary verification runs only its
scope guard and guard tests.

## Test Requirements

- **Docker** must be running for integration tests
- **Node.js 22+** required
- Run `yarn build` before integration tests

## Test Structure

See [STRATEGY.md](./STRATEGY.md#test-structure) for complete test organization.

**Summary**:

- `test/unit/` - Vitest unit tests
- `test/integration/` - Bash integration tests and Vitest E2E tests

## What Each Test Does

### Unit Tests (`yarn test`)

Unit tests run **in-process** against the Container Server using native `fetch()`. Tests execute business logic for DNS, tokens, routes, and workload orchestration.

**Key features**:

- **In-process testing**: Container Server runs directly in test process (no separate HTTP server)
- **Vitest mocking**: GitHub authentication is mocked globally via `test/setup.ts`
- **Fast execution**: Tests run sequentially to avoid port conflicts (`fileParallelism: false` in vitest.config.mts)
- **Native fetch**: Uses standard `fetch()` API, no external libraries

**Example test structure**:

```typescript
import { callApi } from './helpers/api-test-helper';

it('should create workload', async () => {
  const response = await callApi('https://example.com/v1/workloads', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-token',
      'AnyCloud-Client-Version': TEST_DAEMON_VERSION,
    },
    body: JSON.stringify({ ... })
  });

  expect(response.status).toBe(202);
});
```

The `api-test-helper` starts the API on an ephemeral port using `beforeAll` and stops it using `afterAll`.

### Integration Tests

**Local Integration (no cloud credentials required):**

- `yarn local-runtime:setup && yarn test:local-smolvm:runtime` - one
  low-width bare-image vendor install plus cold boots from the versioned
  `.smolmachine`, independent SSH/workload identity, production startup-script
  delivery, the installed `initializeVM` fast path, `overlay2`, and VM container
  profiles. Setup builds the stopped image once with checksum-pinned Docker,
  rclone, and the fixed nuke workload cache.
- `test/integration/e2e.sh local-held-job --vitest` (also `local-completed-job`,
  `local-resubmitted-job`) - credentialless CLI Local Job E2E
- `test/integration/e2e.sh local-smolvm-vm --vitest` - credentialless CLI Local VM lifecycle, SSH
  access, container repair, provider-confirmed host-loss failure, and cleanup E2E
- `test/integration/e2e.sh local-smolvm-serve --vitest` - credentialless CLI Local Service create,
  hard-restart recovery, upgrade, HTTP forwarding, and cleanup E2E
- `NUKE_PROVIDER=<provider> test/integration/e2e.sh nuke` - concurrent lifecycle
  replay with API memory and structured runner-host/API-container metrics; the
  reusable `.github/workflows/nuke.yml` is the single CI and manual workflow
  owner. Local adds smolvm machine and disk metrics; cloud providers retain their
  real spot and bucket-sync behavior.

Nuke's default-off `interrupt_after_witness` workflow input is a declared fault
control. After the full normal cohort and first witness admission, it requires
an active tracked Workload, holds the admitted witness wrapper for at most 30
seconds, and sends TERM twice. Validation requires the original exit 143,
reaped submission groups, both callers' inventories and cleanup, and successful
backstops. Normal runs retain every completion, fairness, memory, database and
SSH gate. Every workflow attempt retains compact source/outcome records and
validated raw cleanup records for 30 days under `implementation-evidence-nuke-*`;
broad failure diagnostics remain available for three days. These are
implementation records and add no formal qualification credit.

**Cloud Integration (requires cloud credentials):**

- `yarn test:*-happy` - Cloud provider workloads (Vitest)
- `yarn test:*-preempt` - Spot instance preemption (Bash)

**E2E (`test/integration/e2e.sh <name> [--debug]` — runs one test on its own freshly-booted
conductor; CI fans them out one-per-runner across dedicated Job, VM, and Service workflows,
while Local smolvm and no-provision legs run on demand in `.github/workflows/integration.yml`):**

- `.github/workflows/e2e-job.yml` - Job and data-path tests such as bucket sync,
  Job host-loss recovery (`*-job-host-unreachable`), concurrent output, SDK,
  and secrets
- `.github/workflows/e2e-vm.yml` - persistent VM lifecycle plus externally
  deleted-host failure on AWS, Azure, GCP, and Lambda
- `.github/workflows/e2e-serve.yml` - public Service and hosted-API tests
- Tests end-to-end workload and data synchronization workflows

**Detailed test descriptions**: See [STRATEGY.md](./STRATEGY.md#bash-integration-tests-daemon)

## CI/CD

GitHub Actions runs on every push/PR:

1. Style checks
2. Build
3. Unit tests
4. Integration tests

See [`../.github/workflows/tests.yml`](../.github/workflows/tests.yml) for workflow details.

## Troubleshooting

**Docker not running?**

```bash
# macOS
open -a Docker

# Linux
sudo systemctl start docker
```

**Port conflicts?**

```bash
# Kill process on port 4142
lsof -i :4142 | grep LISTEN | awk '{print $2}' | xargs kill -9
```

**Tests failing?**

```bash
yarn clean && yarn build
# Linux with writable /dev/kvm:
yarn local-runtime:setup
yarn test:local-smolvm:runtime
```

## More Information

- **Testing Strategy**: [STRATEGY.md](./STRATEGY.md) - Comprehensive guide
- **CI/CD Workflow**: [`../.github/workflows/integration.yml`](../.github/workflows/integration.yml)
- **Main README**: [`../README.md`](../README.md#testing)
