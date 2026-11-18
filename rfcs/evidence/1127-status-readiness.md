# Deployment status and readiness qualification

The settled design is **A: SQLite inventory plus live individual status**.
Kubernetes owns runtime facts and native exec probe results; SQLite owns desired
configuration and Job ownership. Inventory makes no Kubernetes requests.
Individual observations are bounded to one second and retain no readiness cache.

The original spike
retains the results, source identities, and A/B measurements.
Its local run used source `21be6b254902a20b0857706155f189fb228632c0` plus the
recorded experiment hashes. B reduced requests when fetching every live status,
but that did not justify runtime dependencies in ordinary inventory. The source
size comparison was retrospective, not a measurement of maintenance effort.

## Production owners

| Behavior                             | Implementation                                                                      | Verification                                                                                     |
| ------------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Desired exec probe                   | Shared Deployment contract, migration 0107, Deployment store and native manifest    | Contract/store/migration/manifest tests, generated Python models and wire tests                  |
| Individual status and drain blockers | Deployment domain/status projection, bounded Kubernetes gateway and SQLite snapshot | Status/domain/CLI tests and the tracked two-slot Kubernetes contract                             |
| Committed availability               | Shared `job-changes.ts` instance and Workload/Deployment stores                     | Writer rollback/CAS, retry, cleanup, isolation and shared-wait tests                             |
| Runtime-only wakeup                  | Deployment discovery plus `kubernetes/deployment-pod-changes.ts` and `pod-watch.ts` | Authentication/fencing, stream cancellation/proxy/reconnect, and warmup/recovery timing evidence |
| Runtime qualification                | `test/integration/e2e/` managed Kubernetes contract, transports and Python fixture  | Full production API/installed SDK path, process replacement and tracked cleanup                  |

The executable spike, experiment tests, preview responses, and B-only batching
have been removed as these proofs moved into their owning directories. The
archived PR retains the original experiment and its measurements; no prototype
module remains in the production dependency graph.

## Recorded production validation

A change at source
`0c69c6a4010fd31afe7e38b026cf30475866ccd6` passed `yarn verify`: 438 test files,
10,818 tests. `yarn test:local-k8s-e2e` passed control-plane host recovery and
managed Kubernetes run `de98b5035b`. The latter qualified native warmup,
readiness loss/recovery, two-slot generation drain, probe-only update/removal,
Pod/container replacement, full API process replacement, and installed Python
SDK operations. Tracked deletion and independent substrate-absence assertions
passed, with no run-owned Docker containers remaining.

A later change at runtime source
`9d7f8a5e665a46b879ea3e526af5a878b4f95fdd` passed `yarn verify`: 439 test files,
10,844 tests. The full local Kubernetes command passed host recovery and managed
run `fecc5bb570`, including the existing lifecycle, two-slot drain, replacement,
API restart, and installed SDK recovery scenarios. Both warmup and readiness
recovery returned prequeued work on the original waiting receive, without
another Job mutation and before its 20-second deadline.

| Scenario           | Control to probe success | Probe success to `next_job` return |
| ------------------ | ------------------------ | ---------------------------------- |
| Initial warmup     | 253 ms                   | 192 ms                             |
| Readiness recovery | 147 ms                   | 37 ms                              |

The runtime run produced `readiness-wakeup-d-warmup-12108f5f-fecc5bb570.json` and
`readiness-wakeup-d-readin-d34c47d6-fecc5bb570.json` under
`/tmp/e2e-results-kubernetes-vitest-74974`. These records correlate the waiting
receive sequence, Job ID, Pod UID, release time, probe success, and receive
return. Tracked deletion and independent substrate-absence assertions passed;
the fixture recorded no failures or diagnostic errors, and no run-owned Docker
containers remained.

The probe-to-return interval includes kubelet publication, watch delivery,
authentication, discovery, exact claim, and SDK return. Both timestamps for that
interval come from the same container clock; the control interval uses fixture
wall clocks and requires ordered timestamps. This interval differs from the
original spike's notification-only measurement. These are local observations,
not latency guarantees. Subsequent CLI output checks ensure the detailed
readiness explanation is not contradicted by a terminating Pod's last raw
ready flag; current branch verification is recorded in the PR.

## Remaining qualification

The API's Kubernetes credentials need namespace-scoped Pod `watch` access in
addition to existing Pod reads. Preflight checks this permission. No new public
receiver API, SDK default, Job state, lease, heartbeat, or observation table is
required. Native probe configuration and detailed status are owned by this
readiness work; shared waits, committed writers, and exact-claim recovery are
coordinated with a separate effort.

Local results do not qualify Azure or close out the remaining cloud work. Keep
both this readiness work and the coordinated effort open through review and
their remaining acceptance, including the separate cloud qualification. This
record does not change RFC 0017's historical Bash retirement
evidence or RFC 0029's overall acceptance decision.
