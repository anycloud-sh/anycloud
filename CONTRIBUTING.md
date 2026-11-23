# Contributing to AnyCloud

For new cloud or scheduler integrations, read [`ADDING_PROVIDERS.md`](ADDING_PROVIDERS.md) before touching provider code.

Install dependencies with `yarn install --frozen-lockfile`, open an issue before
large changes, and run `yarn verify` before opening a pull request. CI runs a
pull request from a fork on GitHub-hosted runners without secrets; jobs that
reach a cloud run only on maintainers' branches. Contributions are accepted
under the [Apache License 2.0](LICENSE). Participation follows the
[Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/);
report conduct concerns to support@anycloud.sh and security issues as described
in [SECURITY.md](SECURITY.md).

## Directory ownership

Keep behavior with the system that owns it:

- `src/` contains shipped product behavior.
- `test/` contains tests, fixtures, harnesses, and test-only helpers.
- `ci/` contains automation used only by CI workflows.
- `experiments/` contains temporary executable proofs with explicit promotion
  and deletion criteria.
- `benchmarks/` contains performance probes.
- `scripts/` contains supported developer, release, repository-policy, catalog,
  and recurring operator entrypoints.
- `changelog-unreleased/` contains one file per pending changelog entry. It sits
  outside `docs/` so the site never publishes an entry before its release.

Do not use `scripts/` as a staging area for product code, internal applications,
test behavior, or spikes. Promote a successful proof into its owning directory
and `test/`, or delete it when its decision is complete.

Run a spike or live reproduction against real clouds, such as re-running a
user's Job with a branch's CLI, as an `experiments/<name>/run.ts` that a
maintainer dispatches through the [Spike workflow](.github/workflows/spike.yml); see
[experiments/README.md](experiments/README.md). Do not run it from a local API
with a workstation's cloud credentials. The workflow passes every cloud
credential CI holds (AWS, Azure, GCP, Lambda, and Cloudflare); a cloud without a
CI secret needs one added first.

## Task context

For issue-backed work, use the GitHub issue body and relevant comments, including
agreed scope amendments, as the primary task context. Distinguish accepted
decisions from suggestions, rejected proposals, and separately scoped follow-up
work. Record material scope changes agreed in chat on the issue or PR so other
sessions can recover them. For behavior shared across providers, covering fewer
providers is a scope reduction; see
[Cover every applicable cloud](#cover-every-applicable-cloud).

Scope work to what was asked: "all of these" means the items in the message just
before it. Mention other open items in one line at most, and don't file issues,
trackers, or PRs the request didn't ask for. Planning a milestone is local
investigation until a maintainer says to file it. A requested multi-PR plan lives
in an issue body in the
[Release tracker](.github/ISSUE_TEMPLATE/release-tracker.md) format, with the
maintainers' answers on merge authority, size overruns, and parallelism recorded
under Owner decisions.

For chat-only work, use the original user request and material corrections. When
handing work to another agent, pass those requirements verbatim, separately from
the implementation plan or summary. Capture a short task brief using these
concepts:

| Field                       | Meaning                                                                                                                                                     |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Smallest useful outcome** | The observable result needed, including relevant boundaries and completion criteria. For an investigation, this is the decision the evidence should enable. |
| **Motivating evidence**     | The request, incident, reproduction, or investigation that justifies the work. Link sources and distinguish observations from hypotheses.                   |
| **Priority**                | P0 immediate, P1 high, P2 medium, P3 low, or **Untriaged**, with a short rationale. Label agent estimates **proposed**.                                     |

Priority describes scheduling urgency; review severity describes the impact of
a finding. Keep missing information explicitly unknown and missing priority
**Untriaged**, and continue useful work with the available context.

Optionally use `.context/review-request.md` when local continuity across sessions
or tools needs a persisted handoff. If used, preserve the original user request
verbatim, separately from the task brief and implementation plan. Include source
links and subsequent corrections and scope approvals, including the proposal an
approval refers to, and keep the snapshot current. This gitignored file is a local
aid; the issue and user amendments remain authoritative.

Review the diff and validation against the smallest useful outcome and the
motivating evidence. Use the linked issue, relevant amendments, and PR description
or the supplied chat-only requirements. Identify any missing context and continue
reviewing what the available evidence supports.

### Issue triage

Before filing, commenting on, or re-scoping an issue from a user report,
reproduce it and find the root cause. Reproduce with the released `anycloud`
binary from [anycloud-sh/releases](https://github.com/anycloud-sh/releases): a
lower-level minimal case can support the issue, but its repro must show
`anycloud` itself. Where the runtime may be the cause, include a control that
runs the same code under Node beside the binary. For API-dependent commands, use
fixed data as in the CLI [Before / After](#pull-requests) comparison. Separate
distinct bugs from symptoms of one cause, and name which commands are and aren't
affected.

### Parallel agent work

When a coordinator runs agents in parallel, each agent works in its own
worktree and branch inside the coordinator's workspace and runs
`yarn install --frozen-lockfile`. Every checkout stays inside that workspace,
never under `/tmp` or a scratch directory; for a snapshot of an older commit,
`git archive <sha> | tar -x` into a gitignored directory inside the worktree.
Each agent writes its PR body file inside its own worktree under a PR-specific
name, such as `.context/pr-1234-body.md`, never under a shared name, and after
each update checks with `gh pr view <n> --json body` that the body is still its
own. The coordinator starts every review: an agent asks it with the PR and
commit SHA, and it starts a read-only reviewer with a fresh context, which posts
`Review of <sha>:` on the PR. Agents never review with in-process subagents. A
release has one coordinator, and it and its agents coordinate on the release
tracker issue, which records decisions; see its
[template](.github/ISSUE_TEMPLATE/release-tracker.md). Their ready PRs share
paid live runs through the tracker's merge train. An agent also posts a
question the coordinator leaves unanswered for 30 minutes on the tracker.
Separate coordinator-level sessions never message each other directly, except
to link a tracker comment.

## Code review

This is the shared review policy for every coding agent.

### Context and scope

Follow [Task context](#task-context). Read the linked issue and relevant
discussion, agreed amendments, and PR description. For chat-only work, use the
supplied original request and material corrections. Use a local snapshot when
available and applicable to the review target. Compare the diff and validation
with the smallest useful outcome and motivating evidence. Identify any remaining
uncertainty and continue the normal review.

Read the full changed files, including new files in the review target, and
applicable repository instructions. Check surrounding control flow, error
handling, existing consumers, and conventions; the diff alone is not enough.
Review the change and affected behavior. Report relevant pre-existing issues
that the diff touches or exposes, label them accurately, and avoid unrelated
audits of unchanged code.

### What to assess

Look for correctness, security, error-handling, and unintended behavior changes,
including realistic edge cases and races. Flag performance problems when there
is concrete evidence of impact. Check whether the code fits existing owners and
patterns. Verify library and API behavior when needed before claiming misuse.
Treat an unexplained gap in provider coverage as a finding; see
[Cover every applicable cloud](#cover-every-applicable-cloud).

In tests, flag assertions on CLI or process output wording where an exit code,
state, shared constant, or server message would prove the same outcome; see
[Assert outcomes, not wording](#assert-outcomes-not-wording).

Identify unnecessary additions, even when their implementation is correct.
Explain what can be removed while still satisfying the request. Assess new
abstractions, configuration options, persisted fields, fallbacks, retries, and
dependencies against current consumers, documented contracts, and concrete
failure modes. Support findings with evidence that the added structure is
unnecessary, and check for machinery left behind by removed behavior. Prefer
changes within existing owners; small local duplication can be clearer than a
generic helper with mode flags and callbacks. Ask whether the change adds a
private copy of a retry loop, header parser or other helper `src/shared`
already has.

Recommend specific deletions or simplifications that preserve required behavior
and documented security, ownership, credential isolation, admission, recovery,
and cleanup guarantees. Explain what can be removed and why the remaining
design suffices, linking detailed evidence. Request written rationale only for
material choices as defined in [Code Quality](#code-quality); use existing
explanations and avoid requests for repeated rationale or separate
justifications for routine details. Avoid unrelated refactors, speculative
requirements, and style-only complaints based on personal preference.

### Findings

Report only actionable findings. Investigate before calling something a bug;
explain the realistic scenario, inputs, or environment that causes it and the
resulting impact. If an issue cannot be verified, identify the uncertainty
rather than presenting it as a definite bug. Confidence that a problem exists
is separate from confidence in its proposed fix.

Report every finding with these three labeled fields, in addition to describing
the issue:

1. **Severity** — how bad it is if it ships: **critical** (data loss, security
   hole, or outage), **major** (incorrect behavior users will hit), **minor**
   (edge case or rough edge), or **nit** (style or cleanup). Judge by production
   impact, not by fix size; do not overstate severity.
2. **Fix confidence** — how confident you are in the fix you recommend: **high**
   (the fix is clear; state it), **medium** (plausible fix that needs
   verification; state it and what to verify), or **low** (root cause unclear;
   say what to investigate instead of guessing a fix).
3. **Introduced by this change** — **yes** (this diff adds the problem),
   **pre-existing** (already on the base branch; this diff only touches or
   exposes it), or **unclear**. Check the base branch with git blame or the
   pre-image of the diff before answering rather than guessing.

Order findings by severity, and keep the three fields on every finding,
including minor ones. When **Fix confidence** is **high**, also include a
**Fix estimate** field: approximate lines of code (LOC) added, modified, or
deleted and the number of files changed to implement the recommended fix,
including relevant tests. Use ranges when uncertain, name the likely files, and
state any assumptions. Estimate the fix itself, not the size of the reviewed
diff or the net line-count change.

Distinguish optional improvements from required fixes. Keep feedback direct,
matter-of-fact, and easy to scan; avoid flattery. If no simplification is
warranted, say so.

## Code Quality

Meet the agreed requirements and preserve required guarantees. Added complexity
should address a concrete requirement, failure mode, or maintenance problem.
Delete superseded machinery before building, and choose the leanest design that
meets the decision. Before adding a helper for something cross-cutting, such as
retries, backoff, header parsing or time, search `src/shared` and extend what is
there; `withRetry` and `retryAfterMs` own retry loops and `Retry-After`. A
duplicate needs a reason in the PR body.

AnyCloud keeps no backwards compatibility. A removed feature goes away without
aliases, shims, or upgrade and migration warnings, unless a maintainer asks for
one; the issue records that exception. Reviewers don't flag missing
compatibility, but do flag a change that would silently lose or corrupt data in
the current release. If a removal would make users silently lose in-flight work,
ask the maintainers.

Briefly explain only material design choices and trade-offs where they are made:
decisions affecting contracts, security, recovery, ownership, or substantial
maintenance burden. State each rationale once and link detailed evidence.
Routine implementation details need no separate justification.

```bash
yarn check:policy # Check non-suppressible repository policy
yarn style        # Check repository policy, lint, and formatting
yarn fmt          # Auto-format code
yarn build        # TypeScript compilation
yarn verify       # Run the full local verification suite
yarn clean        # Clean build artifacts
```

Pull requests run the same `yarn verify` checks in CI. The **Style** workflow
runs `yarn check:boundaries` and `yarn style`, which runs its checks in
parallel. The **CI** workflow runs `yarn build` and `yarn test`, split into
three shards that run in parallel. Fork and Dependabot pull requests run on
GitHub-hosted runners, and CI skips the jobs that read secrets or reach a cloud
for them.
`test/unit/ci/verify-ci-parity.spec.ts` fails if a `verify` check loses its CI
step. CI also runs checks that `verify` does not. CI runs the Python SDK
checks: `yarn generate:python-sdk`, which needs Python and Java, then `yarn test:generated-python-sdk`,
`yarn test:generated-python-sdk-wire` and `yarn test:python-api-wire`. The `test-sdk`
and `installed-sdk` jobs build the SDK wheel and source distribution and test
them in a clean environment, which has no single local command.

### Size estimates and justification

Estimate size before implementing, and report it after. The task brief or plan
states the expected lines added separately for source and for tests. Tests are
spec files and their fixtures; harnesses, helpers, and test infrastructure count
as source, as do configuration and workflows. The PR description reports each
estimate next to its actual count, for example `Size: source estimated +250,
actual +270; tests estimated +300, actual +330; removed −120`. Exclude generated
files, lockfiles, and snapshots. Deletions are reported but never count against
an estimate.

Maintainer approval is needed before merge when added source lines exceed their
estimate by more than 15% and by more than 100 lines, or added test lines exceed
theirs by more than 30% and by more than 100 lines. Explain the overrun in the
justification table below, and record the approval on the PR. Test additions get
the same scrutiny as source: a fixture, builder, or case that repeats an
existing one is a removal candidate. When a maintainer decision changes the scope,
re-estimate in the brief and cite the decision; the overrun is measured against
the latest estimate.

When a change adds something its task brief or design did not call for — an
abstraction, option, persisted field, fallback, retry, dependency, status
surface, or a whole component — the PR description carries a table with one row
per addition:

| Addition                        | Why                                                                           | Without it                                                 |
| ------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------- |
| What was added, by file or name | The requirement, review decision, defect, or failure mode that made it needed | What breaks, or which guarantee is lost, if it is left out |

Link the evidence (the review comment, the failing run, the issue) instead of
repeating it. An addition whose **Without it** cell reads "nothing" is a
candidate for removal, not for a justification. Reviewers read the table
against [What to assess](#what-to-assess).

### Repository policy

`yarn check:policy` runs separately from ESLint and cannot be suppressed by an ESLint
directive. Ruleless, file-wide, same-line, multi-rule, and unapproved protected
rule disables are rejected. A necessary protected exception must identify one
exact rule and rationale and be added to the reviewed allowlist in
`scripts/repository-policy/eslint-directive-policy.mjs`; a source comment cannot
authorize itself.

The environment, workload admission-write, API-contract, provider
test-mode, and Express registration rules are reviewed-source enforcement
checks configured in `eslint.config.mjs`. Module ownership,
production-to-tooling directory, and raw-database boundaries are whole-graph
checks in `.dependency-cruiser.cjs`, run by `yarn check:graph`; dynamic
module loading is disallowed in production source, and the loader names
themselves (`require`, `module`, `getBuiltinModule`) cannot appear in these
scopes in any position, so every load stays visible to the graph. Static
imports may use relative paths, bare packages, or `node:` built-ins; executable
or off-graph URL schemes such as `data:`, `file:`, and `https:` are rejected.
These checks defend against accidents and literal-form evasion; constructed
evasion is review's responsibility. Scopes that need no lint exceptions use
`noInlineConfig`.

VM lifecycle orchestration consumes a bound `VmCompute` from the named
Workload or cluster composition root. Preserve the attempt credential, native
ID, region, and zone through observations and cleanup; new paths must choose
the documented legacy-credential behavior explicitly. The protected
`local/exact-vm-compute-ownership` rule reserves raw lifecycle operations for
the handle and named provider gateways, including extraction, aliases, and
literal computed keys. Ship new composition roots with behavioral coverage
and accepted/rejected rule fixtures.

Integration entrypoints are checked by `yarn check:boundaries` in local
verification and Style CI. The layout check inspects declared workflow,
composite-action, and package commands, including literal matrix selections.
Use repository-root program paths and complete package aliases; forwarded
arguments are test data. Computed programs and unsupported inline or command
wrappers fail this check. Existing executable utilities have exact owners in
`scripts/repository-policy/integration-entrypoint-owners.mjs`; other helpers
are libraries. Root shell sources are split into closed migration,
shell-native qualification, benchmark/load, and destructive-backstop owners;
RFC 0017 records every registered path exactly once as Replace, Relocate, or
Retain. New Workload scenarios use the constrained fixture; temporary provider
proofs use documented experiments covered by the tooling TypeScript project.
Wrapper internals require code review and executable tests: the check does not
trace shell variables, function calls, imports, or child processes across
files.

`yarn check:docs`, part of `yarn check:boundaries`, keeps the canonical
documents named in `AGENTS.md` consistent with the tree. Each backticked path
must exist in Git's view of the tree, from the repository root, `src/`, or the
document's directory, unless it has a listed external prefix. Each relative
link must reach an existing file and heading anchor, and each `yarn <name>` in
code must name a package.json script, package binary, or Yarn command. When a
move or rename strands a reference, update it to the current path, anchor, or
script name in the same change. The check does not read bare filenames, globs,
reference-style links, or setext headings.

Every constrained Bash E2E member has retired under RFC 0017's green-streak
rule; `test/integration/e2e/RETIREMENT.md` is the frozen record.

Selected tests must execute their assertions or fail. Missing credentials,
provider outages, insufficient capacity, and unavailable parity oracles are
failures. The protected `local/no-skipped-or-focused-tests` lint rule rejects
skip/focus APIs, placeholders, and conditional registration. Tests may return
after asserting their outcome; unavailable prerequisites must fail. Both Vitest
configurations require assertions and reject focused or empty suites. Requiring
an assertion catches empty tests, but each test must still verify its promised
outcomes. The discovery check verifies these settings and effective skip lint
coverage for every discovered test. The shell qualification check rejects
exit-77 skips, disabled test blocks, and optional execution switches. The common
runner preserves every nonzero exit through evidence capture and cleanup.

`ci/install-runner-tools.sh` supplies the cloud CLI toolchain, checked by
`ci/check-cloud-tools.sh` before tests create resources; test matrices do not
select CLI installation. Provider fixtures own identity observations,
credentials, and concrete target configuration. Keep common recovery assertions
and cleanup in the shared lifecycle. The qualification check rejects new
provider-name predicates in shared shell helpers, preserves exact legacy
predicates until migration, and requires the Job workflow's shared queue and
every post-matrix cleanup job and its enabled command. The discovery check verifies all three constrained
fixture rules are active at error severity and the default runner cannot
select those specs.

Other lint rules are accidental-misuse and consistency guards rather than
security boundaries. These checks constrain reviewed source code; they do not
configure repository-hosting or merge policy.

API code may construct credential-bearing cloud SDK clients only in the audited
modules under `src/api/services/provider-clients/`. Add each known constructor
import to the exact repository allowlist, accept selected stored credentials
separately from client options, and spread credentials last. Call sites import
types, named AWS command constructors, and explicitly allowlisted named helpers
directly from the SDK. `ClientSecretCredential` is the only permitted
`@azure/identity` constructor; ambient credential providers remain forbidden.
Runtime imports from provider SDK families fail closed: factory constructors
and non-command call-site exports must be registered exactly, while namespace,
default, side-effect, and unknown runtime imports are rejected at the import
declaration. A new provider SDK source or runtime export must extend that
import-policy matrix.

## Error Handling

### Principle: Throw, Don't Return False

Functions should throw errors on failure rather than returning `false` or status codes. This ensures:

- Errors propagate to callers automatically
- `runStep` transitions to an error state (`onErrorState`) and can run an `onError` handler on failure
- Error messages provide context for debugging

**Do this:**

```typescript
async function initializeVMs(vms: VM[], props: StoredWorkload): Promise<void> {
  if (!sshPrivateKey) {
    throw new Error('SSH private key missing from workload request');
  }

  const allSSHReady = await this.waitForSSH(vms, sshPrivateKey);
  if (!allSSHReady) {
    throw new Error('SSH connection failed on one or more VMs');
  }

  // Success - no return needed
}
```

**Not this:**

```typescript
async function initializeVMs(
  vms: VM[],
  props: StoredWorkload,
): Promise<boolean> {
  if (!sshPrivateKey) {
    log.error('SSH private key missing');
    return false; // Caller might ignore this!
  }
  return true;
}
```

### Error Messages

Include the actual error when available:

```typescript
// Good - includes actual error
throw new Error(failedStarts[0].error || 'Container failed to start');

// Bad - generic message loses context
throw new Error('Container startup failed');
```

### State Transitions on Failure

- **Errored** = Application/container issue (e.g., container exits non-zero, startup fails)
- **Failed** = Infrastructure/workload issue (e.g., SSH fails, timeout, VM never started)
- **Invalid** = User-input configuration error (e.g., invalid bucket name, VM type not available) — never retried. Detected by `isUserError()` in `error-formatter.ts`

Set state before throwing when the state change is meaningful:

```typescript
if (failedStarts.length > 0) {
  await getWorkloadLifecycle().updateState(props.id, WorkloadState.Errored);
  throw new Error(failedStarts[0].error || 'Container failed to start');
}
```

For infrastructure failures, let `runStep`'s `onErrorState` (e.g. `Failed`) capture the failure.

### Background Tasks

Two primitives cover async work:

`runStep` runs and **awaits** a single workload step: it logs the start, enforces `timeoutMs`, and transitions the workload to `onErrorState` (or runs `onError`) on failure — and optionally to `onSuccessState` on success.

```typescript
await runStep({
  id: props.id,
  step: WorkloadState.Provisioning,
  timeoutMs: PROVISIONING_TIMEOUT_MS,
  onErrorState: WorkloadState.Failed,
  fn: async () => {
    await deployMan.newVMs(props, vmCount);
  },
});
```

`fireAndForget(promise)` detaches a promise so it runs in the background without an unhandled-rejection warning. Errors must be handled inside the promise (typically because each step already uses `runStep`):

```typescript
fireAndForget(termination.terminate(cloudConfig, id));
```

### Logging vs Throwing

- **Don't log and throw** - redundant, `runStep` logs errors
- **Do throw with descriptive message** - the error will be logged by the caller

```typescript
// Bad - logs twice
log.error('SSH failed', { id });
throw new Error('SSH failed');

// Good - just throw
throw new Error('SSH connection failed on one or more VMs');
```

Exception: Log additional context that won't be in the error message, then throw:

```typescript
log.error('Multiple VMs failed', { failedCount, failedIPs }); // Extra context
throw new Error(failedStarts[0].error); // First error for the exception
```

## Testing

### Unit Tests (Vitest)

```bash
yarn test        # Run all unit tests
yarn test:watch  # Watch mode; constrained E2E members never run here
```

`yarn test:mutation:harness` runs the opt-in mutation pilot for selected E2E
harness code. `yarn verify` runs its scope guard, without running mutation tests.
Development dependency installation requires Node 22.18+, 24.11+, or 26+ because
of Stryker's Babel dependency. See the [mutation guide](test/mutation/README.md)
for the exact scope, sandbox qualification, reports, and manual CI workflow.

### Integration Tests

Integration suites are per-target — there is no umbrella script. Examples:

```bash
yarn local-runtime:setup                         # Linux/KVM: prepare smolvm
yarn test:local-smolvm:runtime                   # Live Local runtime contracts
yarn test:aws-bucket-sync:vitest                 # Bucket sync (also azure-/gcp-/lambda-)
yarn test:aws-sad                                # Sad-path (also azure-/gcp-/lambda-)
yarn test:quota                                  # Quota flow
# See the "test:*" scripts in package.json for the full list
```

Managed Kubernetes CPU cloud qualification can run concurrently across branches.
Each CPU run and attempt builds a distinct API image tag with a matching SDK
version. GPU qualification retains immutable candidate artifacts and serializes
capacity per provider at its qualification job. Both profiles tear down their
tracked resources without sweeping other runs' cloud resources. Existing runs
keep the workflow they started with, so update the target branch to use this
behavior.

Browser consent and MFA are checked manually using the
[release browser-auth checklist](docs/release-browser-auth-checklist.md); CI
owns every terminal step before and after that boundary.

The `test:local-smolvm:runtime` integration suite exercises both the prepared
Local runner and exactly one bare guest through smolvm. It verifies that:

- cold boots receive independent SSH host and workload keys;
- the prepared image exposes pinned Docker/rclone, `overlay2`, and its cached
  workload image;
- Docker and rclone are absent from the bare guest before `initializeVM`
  installs them; and
- the shared VM container profile supports minimal, non-root, and nested-Docker
  workloads.

The Local Job E2Es own environment/secrets, Docker options, and normal
input/output/checkpoint synchronization coverage. Native cloud-init/user-data
transport, IAM/metadata, provider networking, spot signals, and real cloud
image services remain real-cloud test responsibilities.

### Cover every applicable cloud

A change, test, spike or live check that concerns behavior shared across
providers, such as provisioning, preemption, failover, billing, error
classification or catalogs, covers every provider where that behavior exists:
AWS, Azure, GCP, Lambda and, where applicable, Local. List each provider left
out with a one-line reason, such as "Lambda: no spot". Covering fewer providers
is a scope reduction that the PR description states. A missing CI credential or
workflow is a gap to fix (see [Directory ownership](#directory-ownership)), not
a reason to drop a provider. Deferring a paid run follows the
[dispatch-only rule](#pull-requests).

### Unit Tests

```bash
yarn test    # Unit tests (integration suites run individually; see above)
```

### Assert outcomes, not wording

Assert exit codes, process or cloud state, shared constants, or messages read
back from the server. Assert CLI wording only when the wording itself is the
behavior under test, such as a renderer or the guidance an onboarding journey
promises.

### Prefer integration over heavy mocking

For cloud gateway behavior (AWS, Azure, GCP VM creation, networking, storage, etc.), write tests in the `-happy.spec.ts` integration files against real cloud APIs rather than mock-heavy unit specs. Mocks tend to drift from real SDK behavior and mask regressions.

Eventual-consistency fixture retries use an absolute deadline with injected
clock, wait, and randomness ports. Readiness probes must exercise the exact
fixture identity and the capabilities the test needs; an authentication-only
probe is not permission readiness. Pin created identities to provider responses
rather than deriving resource namespaces from the bootstrap principal's display
form. Provider CLI fixtures must sanitize documented ambient identity overrides,
explicitly select and assert the expected principal, and expose the constructed
child environment to deterministic tests; an isolated CLI configuration
directory is not an identity boundary. A successful exact-identity probe may
return immediately; propagation windows bound retries after failures rather than
imposing a minimum delay. Each probe owns its inputs and any cleanup and must not
depend on a resource created by another test, execution order, or shared
leftovers. Keep retry tests deterministic, including ambiguous writes, events or
failures that arrive between attempts, and the final deadline attempt.

### Prove correctness, not consistency

A test workload that computes a result, such as a GPU or ML workload, proves it
ran where intended and produced the right answer, not only that its Jobs reached
a state or that its outputs repeat. Anchor it to a
trusted reference computed from fixed inputs, such as a CPU energy for MACE or a
CPU audio rendering that Whisper transcribes back to its text, and fail the Job
on a mismatch. A canary Job's error message carries the evidence (value, device,
model-load ID) for the harness to read and check; see the
[E2E guide](test/integration/e2e/README.md). Call a check that only compares
runs with each other a consistency check.

### A/B every speed claim

A change that claims a speedup carries its own A/B before it merges: the same
workload measured on `main` and on the branch, with both sets of numbers in the
PR description. Run it as an `experiments/<name>/` dispatched through the
[Spike workflow](.github/workflows/spike.yml), never in E2E or integration suites,
which check correctness and record plain timings. Without a measured gain, drop
the speed claim and reconsider the change.

### Mocking

Use `vi.spyOn` on prototypes for class methods:

```typescript
// Good - works reliably
vi.spyOn(DockerManager.prototype, 'runFromImage').mockRejectedValue(
  new Error('Container start failed'),
);

// Bad - vi.doMock is called too late
vi.doMock('../services/docker.js', () => ({
  DockerManager: vi.fn().mockImplementation(() => mockDockerManager),
}));
```

## Debugging

**API:**

- Set `ENV=local` for detailed logging
- Check API logs: `anycloud api logs` or `docker logs anycloud-api`
- Debug operational API endpoints with the required version header:
  `curl -H "AnyCloud-Client-Version: $(node -p "require('./package.json').version")" http://localhost:8080/v1/...`

**Common Issues:**

API container not starting:

```bash
anycloud api stop   # clean up stale state
anycloud api start  # restart
docker logs anycloud-api  # check logs
```

## Documentation

- Edit `docs/` for feature/API changes — that's the source for the next release.
- A PR that adds a migration or changes which module writes a table updates the Durable Data Model section of `ARCHITECTURE.md` (its diagram and table notes) in the same PR.
- Changelog entries go in a new file under `changelog-unreleased/`, named for the PR (`975.md`), one `###` heading and one paragraph. `docs/changelog.md` holds released versions only; the release folds the pending files in, so never edit it by hand.
- Versioned snapshots under `website/versioned_docs/version-*/` are frozen for functional changes. Don't retroactively document new/removed features.
- **Exception:** pure cleanup (typos, dedup, clarity, link fixes) should be mirrored into the current stable `website/versioned_docs/version-*/` folder so shipped docs benefit. Check `ls website/versioned_docs/` for the current stable version.

## User-facing copy

Changelogs, docs, landing pages, marketing — describe features on their own terms. Don't name competing products ("Modal-style map", "SkyPilot-like") in copy users will read.

## Pull Requests

Link the task issue and summarize material scope amendments and validation in
the PR description. For chat-only work, include the [task brief](#task-context)
and user requirements, material corrections, and available source links so
reviewers can reconstruct the task context from GitHub.

A PR that changes what the CLI prints (tables, status and progress lines,
prompts, errors) carries a **Before / After** section in its description. Run
the same commands on the same data with the CLI built from `main` and from the
branch, and paste both outputs as text blocks. Fixed data works: a small fake
API serving JSON, reached through `API_URL` on a non-loopback address with
`NO_COLOR=1`. The comparison should show the whole change at a glance.

A PR that changes the persisted data model carries a **Data model: Before /
After** section in its description. That covers any migration, including one
that only rewrites data; a new or changed table, column, constraint, index or
trigger; a changed JSON shape stored in a column; and a change to which module
writes a table. When the schema changes, run
`yarn schema:diagram --base origin/main --tables <table>,<table>` and paste its
output. It runs each side's migrations on an empty database and prints both
mermaid `erDiagram`s, with every foreign key as a labelled edge, and the change
table. Fill in the table's Writer column, and add dotted lines for JSON name
references, as in `ARCHITECTURE.md`. Follow the table with one line on what
stays the same, such as the API wire format or existing columns. A change that
leaves the schema as it was needs only the table. Review holds both Before /
After sections to the same standard.

A PR that changes runtime code under `src/`, `python/` or `migrations/`, or
end-to-end tests, carries **Runtime layers** and **E2E** sections in its
description. Run `yarn pr:sections` and paste its output. The Runtime layers
table has the eight layers of the onion in `rfcs/0044-one-pool-runtime.md` as
rows and shared code, the pool runtime, the VM host and Slurm as columns; each
cell lists the changed modules, marked as added, modified, deleted or renamed,
with their line counts. The E2E section lists the members the PR changes and
the member runs it needs. Each paid member it lists as required needs a linked
green dispatch, under the dispatch-only rule below. Classify files it reports as
unmapped in `LAYER_MAP` or `HARNESS_MEMBERS` in `scripts/pr-sections.ts`.

A PR that claims a speedup carries its [A/B](#ab-every-speed-claim) numbers in
its description.

A PR that changes the API contract carries an **API contract** section in its
description; `yarn pr:sections` prints it too. The OpenAPI document is
committed as `src/shared/api-contract/openapi.generated.json`; run
`yarn generate:openapi` after a contract change, and `yarn check:openapi` fails
when it is stale. The section compares that document at the merge base with the
branch's and reports a change declared on a base or a tag's shared errors once,
with the exact number of endpoints it reaches. On a merge
conflict in the document, rebase, run `yarn generate:openapi` and commit the
result.

1. Create feature branch
2. Make changes
3. Run `yarn style` to check code quality
4. Run `yarn test` to verify unit tests pass
5. Submit PR

All PRs must pass CI checks (style, build, tests). Before merging, if `main`
has gained merges since the PR's last CI run and they touch related areas
(shared clients, the API contract, harness helpers), re-run CI against the
current merge result (rebase, or merge `main` into the branch; a GitHub re-run
reuses the old merge commit) rather than relying on the earlier green.

Plan related changes to share one review, one CI cycle, and one round of paid
live runs: batch them into one PR unless a real dependency or risk forces an
order, and say what forces it.

A review covers only the commits that existed when it ran. Before merge, list
each commit with its review result and review any commit that lacks one, except
a text-only nit fix (wording, PR body, line wraps, comments): list it in the next
review request, or in the final report when it is the last commit, and the next
review, or the coordinator before merge, checks it. Run that review alongside
CI, not after it. Check that the description's `Fixes #<n>` line names the right
issue.

Keep reviewing until a round finds nothing critical or major. After fixing a
critical or major finding, run a fresh independent review of the new head, not
a check of the fix alone. Fix minor findings and nits without another full
round; the commit check above still applies to those fixes.

PR CI does not run dispatch-only live workflows such as `e2e-cluster-cloud`. When
a change is exercised only by one of them (its workflow, substrate, contract or
fixtures), say so in the PR description and link a green dispatch on the branch
before merging. If a maintainer defers that run, no other PR may build on the
unproven path until a dispatch is green.

When a maintainer asks for a test that the PR can't run because it lacks a
credential or fixture, raise that on the PR or the tracker as a blocker before
merge rather than listing it as "Not covered".

## Code Organization

### No Re-exports

Types and functions should have a single source of truth. Import directly from where they're defined - don't re-export them from other modules.

**Do this:**

```typescript
// Import directly from the source
import { CloudConfig, CloudType } from '../shared/cloud.js';
import { completeCloudConfig, getRegions } from '../shared/cloud-config.js';
```

**Not this:**

```typescript
// Don't re-export types from other modules
// In provider.ts:
export { CloudConfig } from '../shared/cloud.js'; // Bad - creates confusion

// In config.ts:
import { CloudConfig } from './provider.js'; // Where does CloudConfig actually live?
```

This prevents:

- Confusion about where types/functions are defined
- Multiple import paths for the same thing
- Circular dependency issues

### Module Structure

- `shared/cloud.ts`, `workload.ts`, `image.ts`, `runtime.ts`, and `quota.ts` - shared value types grouped by concept
- `shared/api-contract/*-schemas.ts` - JSON wire DTOs and validation
- `api/services/workload-record.ts` - API-owned durable workload records
- `api/services/repositories/workload-lifecycle.ts` - atomic step and state transitions, retry admission, recovery, and URL-preserving Service upgrades; each caller declares the interface it uses beside itself and receives the store from `persistence.ts`. It also holds `commitWorkloadChanges`, the one coordinator for transactions that publish wake-ups after commit
- `api/services/repositories/workload-outcomes.ts` - terminal outcomes, termination, resubmission, and cleanup bookkeeping and completion, wired the same way; it holds `cleanupNeededSql`, the one definition of outstanding cleanup
- `api/services/repositories/provisioning-attempts.ts` and `workload-events.ts` - the Workload VM attempt ledger (registration, completion, release, endpoints, billing identity) and the workload event reads and non-transition event writes, wired the same way; event writes inside a complete durable operation stay with that operation
- `api/services/repositories/workload-creation.ts` - the admission-only Workload insert: the row and its owned container spec in one transaction, as a free function that only the admission writer imports; its other consumers import only its types. It is separate from `workload-lifecycle.ts` because sibling repositories import that module's values
- `api/services/repositories/credential-secrets.ts` - encrypted credentials and named secrets, including the reference-guarded deletes, wired the same way; its admission-only `upsertCredential` is a free function that only the admission writer imports
- `api/services/repositories/workload-queries.ts` - Workload query projections, wired the same way: hydrated reads, `list` and `status` on the `db.read` connection, the terminal digest rows, scheduling and reconcile candidates, and the VM rows operations read; it performs no transitions
- `api/services/repositories/workload-spend.ts` - the spend reads, wired the same way: the windowed cost report that `anycloud cost` and the budget-cap alert read, the exact per-workload cost, and the digest's start counts and VM spend; it holds `windowedVmSpendSql`, the one windowed VM spend definition, which `spend-controls-store.ts` also uses, and imports the shared VM aggregate and attribution filters from `workload-queries.ts`
- `api/services/workload-event-metadata.ts` - redacted workload-event metadata encoding and decoding
- `shared/cloud-config.ts` - cloud configuration utilities
- `cli/services/*.ts` - CLI-specific logic
- `cli/commands/` - argument parsing and composition; `cli/use-cases/` - application operations that take explicit dependencies and return results or throw, never prompting, printing, or touching process state; interactive input belongs in `cli/prompts/` and human-readable output in `cli/renderers/`, whose builders return lines for the command to print and take terminal width as input (`cli/commands/quota.ts`, `cli/commands/status.ts` and `cli/commands/list.ts` show the split)
- `api/services/*-domain.ts` - transport-free domain semantics with required dependency ports
- `api/composition.ts` - production wiring for concrete persistence, gateways, runtimes, environment, and telemetry
- `api/services/monitor.ts` - composition only: background-service start/stop, scheduling, one builder for every workflow's declared dependencies, and routing reconciler work to its workflow; periodic bodies such as `notifications-digest.ts` (with its rendering in `notifications-digest-format.ts`) and `api/services/cost-calculation/monitor.ts` live with their owners and are imported only by it
- `api/services/workload-workflows/*.ts` - workload workflow families, such as `vm-host-startup.ts` (fresh startup, active-step replay, and in-place resume), `retry-recovery.ts`, the Job `completion.ts` with its reconciler handlers in `completion-reconcile.ts`, the terminal `cleanup.ts`, `persistent-vm-repair.ts`, the dispatch and active-pipeline recovery in `workload-pipeline.ts`, and `provisioning-scheduler.ts`; the pipeline receives the monitor's reconciler as a port, since the reconciler's active-recovery work runs the pipeline; each declares the persistence interfaces it uses and receives them from `monitor.ts` (or, for startup and the Job poll, from `api/services/job/default-runtime.ts`), never importing the monitor, `persistence.ts`, provider gateways, provider clients, or SDKs
- `api/services/host-runtime/*.ts` - host effects shared by workflows, such as the startup readiness, container start and health in `host-startup.ts`, the image pull in `image-delivery.ts`, the persistent-VM container repair in `vm-container-repair.ts`, `vm-release-observer.ts`, and the VM teardown in `termination.ts`; they and the repositories never import a workflow or the monitor

Do not add another catch-all type module or a convenience export path. Import a
symbol from the module that defines it. `yarn lint` rejects source re-exports,
and `yarn check:boundaries` rejects source module cycles.
`yarn check:boundaries` also enforces exact import owners for extracted modules
and the per-file line ceilings in `scripts/check-production-owner-sizes.mjs`;
lower a ceiling when its file shrinks. When a file grows past its ceiling,
split it along its responsibilities; raise the ceiling only for reviewed,
justified growth, in the same pull request, with the rationale in the comment
beside it. 800 lines is where review decides whether a file belongs together,
not a size to aim for: a ceiling above 800 also records `split: '#N'`, an open
issue that splits the file, or `whole: '<the shared responsibility>'`, one
concrete sentence on what its parts share. The check requires the field;
review judges the reason. In `.dependency-cruiser.cjs`, list a consumer that
needs only an owner's types under `typeOnlyFiles`, not `allowedFiles`.

Production owners also have mutation-score floors in
`test/mutant-parity/floors.json`, measured by the
[score step](test/mutant-parity/README.md#scores-and-floors): the share of the
file's scored mutants that were killed, rounded down, minus 5. Timeouts don't
count, since they depend on host load. A file whose score (killed plus timed
out) is under 60% has no floor. Floors ratchet: when a file's score improves,
raise its floor in that pull request. When a score falls below its floor, add a
test, or lower the floor in the same pull request with the rationale in the
[justification table](#size-estimates-and-justification), like a ceiling raise.

### JSON API contracts

- Define JSON boundary schemas in `src/shared/api-contract/*-schemas.ts`; these files import only Zod and other shared value modules.
- Compose each family's HTTP methods, paths, and typed errors in `src/shared/api-contract/<family>.ts`, then assemble them in `contract.ts`. Retry attempts and timeouts come from the `query`/`command` builder metadata, never from the HTTP method or path.
- Implement procedures in `src/api/rpc/`. Procedures authenticate by default, receive already-validated input, and delegate directly to a domain service.
- Put stateful and external semantic validation in `src/api/services/*-domain.ts`, never in a Zod refinement or an RPC procedure.
- CLI JSON transports use the direct typed client in `src/shared/services/api-client/rpc.ts`. Do not add path-based JSON fetch helpers, parallel DTOs, or another transport implementation.
- Keep NDJSON, uploads, and downloads on their native Express/fetch transports. Do not force byte streams through the JSON contract.
- Express construction and HTTP-method registration are confined to the named native transport owners in `eslint.config.mjs`. Add a new owner there through policy review; inline exceptions are disabled in route scopes.
- `yarn check:boundaries` enforces these dependency directions.

### Pure Functions Over Class Methods

Prefer standalone functions over static class methods. Functions are easier to test, mock, and understand.

**Do this:**

```typescript
// Pure functions
export function completeCloudConfig(config: CloudConfig): CloudConfig { ... }
export function getRegions(provider: CloudType): string[] { ... }
```

**Not this:**

```typescript
// Class used only as a namespace
export class CloudConfig {
  static maybeCompleteCloudConfig(config: CloudConfig) { ... }
  static getRegions(provider: string): string[] { ... }
}
```

### Immutable Transformations

Functions should return new objects instead of mutating inputs.

**Do this:**

```typescript
export function completeCloudConfig(config: CloudConfig): CloudConfig {
  if (!config.vmType && !config.region) {
    return {
      ...config,
      region: DEFAULT_REGIONS[config.cloudProvider],
      vmType: DEFAULT_VM_TYPES[config.cloudProvider],
    };
  }
  return config;
}
```

**Not this:**

```typescript
export function maybeCompleteCloudConfig(config: CloudConfig): void {
  config.region = DEFAULT_REGIONS[config.cloudProvider]; // Mutates input!
  config.vmType = DEFAULT_VM_TYPES[config.cloudProvider];
}
```
