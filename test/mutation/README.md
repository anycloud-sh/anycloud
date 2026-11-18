# Mutation harness pilot

The pilot checks whether the constrained E2E harness's unit assertions detect
incorrect behavior. It mutates six explicitly selected harness modules and runs
six existing unit suites. Production code, the deployment kernel, and the
ESLint plugin are outside this campaign.

## Run

Development dependencies require Node 22.18+ on the 22 line, 24.11+ on the 24
line, or 26+. Stryker 10's Babel dependency rejects older Node patches. CI uses
the latest Node 22 patch. This tooling requirement does not change the
application's runtime compatibility.

```bash
yarn check:mutation-scope
yarn test:mutation:harness --dryRunOnly
yarn test:mutation:harness
node test/mutation/qualify-sandbox.mjs
```

The normal command validates scope before starting Stryker. It accepts only
`--dryRunOnly`; edit the reviewed configuration to change source/test selection
or sandbox settings. Ordinary `yarn verify` runs the fast scope check and its
unit tests, without starting a mutation campaign.

The dedicated Vitest configuration skips catalog downloads, database migrations,
and the ordinary global GitHub mock. Its tests use fake dependency ports, local
HTTP fixtures, temporary files, and Node child processes. It does not enable the
constrained E2E provisioning marker.

## Scope and safeguards

`stryker.harness.config.mjs` lists cleanup, wait, controller-session,
persistent-vm-submission, persistent-vm-policy, and persistent-vm-running.
`vitest.mutation.config.mjs` lists the e2e-fixture, e2e-persistent-vm-boundaries,
e2e-persistent-vm-contract, and e2e-persistent-vm-host-loss-contract unit suites
(the controller-session and persistent-VM adapter internals suites were retired
in Lane A W2; their safety cases moved into e2e-fixture and
e2e-persistent-vm-boundaries).
Selections must be nonempty literal file paths, exist within their declared
scope, belong to the mutation TypeScript project, and match actual Vitest
discovery. New matching tests cannot enter the campaign implicitly.

Stryker's `testFiles` option is deliberately absent. Its
[static-activation defect](https://github.com/stryker-mutator/stryker-js/issues/6144)
is present in 10.0.0: that filter activates module-initialization mutants after
their modules load. The scope guard rejects the option and keeps the allowlist
in Vitest. The disposable qualifier also requires a static Boolean mutant to be
killed, so configured static support has direct execution evidence.

The checker project extends `test/integration/tsconfig.json` with an explicit
list of the selected files and Vitest ambient declarations. Imported dependencies
remain checked. The scope guard requires compiler options to match the full
integration project, which ordinary `typecheck:e2e` continues to check. Stryker
checks mutants individually for accurate compile-error classification.

Runner behavior follows the supported [Vitest integration](https://stryker-mutator.io/docs/stryker-js/vitest-runner/).
See Stryker's [TypeScript checker](https://stryker-mutator.io/docs/stryker-js/typescript-checker/)
and [configuration reference](https://stryker-mutator.io/docs/stryker-js/configuration/)
for checker overrides, sandbox copies, and reporting options.

Stryker does not consult `.gitignore` for sandbox copies. Explicit exclusions
cover private configuration and generated files; in-place mutation and negated
exclusions are rejected. The sandbox qualification creates a disposable project
with dummy private files and verifies Stryker omits them while copying a public
sentinel. It never reads real credentials.

These checks constrain the supported command and reviewed configuration. They
are not a security boundary against arbitrary code or direct Stryker invocation.

## Reports and triage

Open `reports/mutation/harness/index.html` and inspect
`reports/mutation/harness/mutation.json`. Reports and `.stryker-tmp/` are ignored
by repository checks. The campaign uses four concurrency tokens (two TypeScript
checkers and two Vitest runners), per-test coverage, and static mutants.
The original four-suite qualification took 7m 28s locally and 11m 2s for the CI command; machine load
affects runtime. Stryker's progress estimates were much longer while TypeScript
checking was in progress, so use completed wall times when budgeting a run.

Default Vitest discovery excludes both generated directories. A regression
fixture creates dummy tests in them and confirms that ordinary discovery omits
the copies while retaining the real unit suites.

Record the source commit, tool versions, runtime, and each status separately:

- `Killed`: a selected test failed with the change active. Inspect its failing
  assertion or error for behavioral evidence.
- `Survived`: the selected tests passed with the change active; inspect the
  changed behavior before deciding whether to add an assertion.
- `NoCoverage`: the selected suites did not execute that behavior. This is a
  coverage gap, not proof of weak assertions.
- `CompileError`: the TypeScript checker rejected the change. It is excluded
  from Stryker's mutation-score denominator and is not an assertion success.
- `Timeout`: mutation exceeded its execution deadline. Inspect these separately
  from assertion kills, even though Stryker counts them as detected.
- `RuntimeError` or `Pending`: execution failed or remained incomplete. The
  command fails after preserving the reports, even with a zero score threshold.
- Other statuses such as `Ignored`: retain their counts separately.

Prioritize incorrect decisions and lost safety checks. Add focused behavioral
assertions with independently specified expectations. Record equivalent,
diagnostic-only, and uncovered cases with reasons; do not weaken types or add
broad mutator exclusions to raise a score. Scores are informational, while
configuration errors, failing baseline tests, and runner failures fail the command.

The [qualified outcome](../../rfcs/0040-targeted-harness-mutation-testing.md#pilot-outcome)
records baseline/final counts, commits, versions, runtimes, and CI reports.
The four-suite campaign left 203 mutants uncovered, including 198 in the full
provisioning orchestrator. A later
VM measurement
established the value of selecting the existing lifecycle and host-loss suites
and adding three invalid observations: missing secrets, a stopped container,
and mismatched VM metadata.
The six-suite campaign includes those regression cases. Current results must be
recorded against their own source and dependency inputs.

The lifecycle and host-loss suites use
`test/unit/helpers/persistent-vm-fixture.ts` for data and fake dependency
responses; scenario sequences and expected outcomes stay in the suites.

## Manual CI

Run the **Mutation Harness** workflow, or:

```bash
gh workflow run mutation.yml --ref <branch>
```

The workflow uses the repository CI backend switch, qualifies sandbox exclusions
and static activation, and runs the same local command. Its job limit is 20 minutes; available HTML and
JSON reports are uploaded even after failure and retained for seven days. It
does not run on pushes or pull requests.

GitHub only permits dispatch once the workflow exists on the default branch.
The RFC records how the identical workflow definition was qualified through
an existing registered entrypoint on a temporary branch before merge.

## Relationship to architecture work

This pilot is tracked on its own, independent of the earlier source/test/contract
reduction work and the architecture-boundary audit. Mutation results
measure assertion effectiveness; they do not qualify that reduction work's I8 result in
required source/test/contract context, or prove the new production boundaries
and I1–I8/S1–S12 requirements the architecture-boundary audit covered.

Architecture-check defects stay with that audit. Future production campaigns should
follow the per-workflow persistence-before-consumer sequence established earlier. Expansion
requires its own bounded scope and evidence that assertion yield and runtime
justify maintaining another campaign.
