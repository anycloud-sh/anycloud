# RFC 0040: Targeted mutation testing of the E2E harness

> Status: Proposed
> Date: 2026-09-10
> Author: Codex draft

## Summary

Passing tests do not establish that their assertions detect incorrect behavior.
Add an opt-in Stryker pilot for six deterministic modules in the
[constrained E2E harness](0017-constrained-vitest-e2e.md), using four existing
unit suites. The result is a repeatable way to find assertion gaps and record
the cost of maintaining a campaign, with enforcement described using
[RFC 0025](0025-enforcement-ledgers.md).

## Proposal

- **Smallest useful release:** `yarn test:mutation:harness` and a manual CI
  workflow mutate cleanup, wait, controller-session, persistent-VM submission,
  policy, and running validation. The fixture, persistent-VM boundary,
  persistent-VM contract, and persistent-VM host-loss contract unit suites are
  the only test selection (the controller-session and persistent-VM adapter
  internals suites were retired in Lane A W2; their safety cases live in the
  fixture and boundary suites).
  Scores are informational; production code, the deployment kernel, and the
  ESLint plugin remain separate follow-ups.
- **Simplest implementation:** Reuse Stryker 10.0.0, its Vitest runner and
  TypeScript checker, a scoped project extending the integration TypeScript
  configuration without compiler-option overrides, and existing unit fixtures.
  A dedicated Vitest config removes catalog/database setup. A fast
  scope validator is required by both the campaign and `yarn verify`; a small
  entrypoint rejects command-line overrides that would bypass that check.
  A disposable sentinel project qualifies Stryker's actual sandbox exclusions
  and static-mutant activation. Suite selection belongs to Vitest: Stryker
  10.0.0's `testFiles` option triggers the upstream
  [static-activation defect](https://github.com/stryker-mutator/stryker-js/issues/6144).
- **Accepted limitations:** Mutation cannot establish type or graph enforcement,
  complete production workflow wiring, or reduced reasoning context. Survivors
  require behavioral triage; compile errors and uncovered code are separate
  evidence. Stryker's Babel dependency requires a recent Node patch when
  installing development dependencies. See the [mutation guide](../test/mutation/README.md)
  for commands, exact selections, reports, and tool requirements.

## Required invariants

1. The campaign mutates only the explicitly selected harness implementation
   files and executes exactly its selected unit suites; an empty, missing,
   broadened, or overridden selection fails before mutation.
   _Enforcement: script:scripts/check-mutation-scope.mjs — exact selections, checker membership, and actual Vitest discovery are checked before execution; the command rejects CLI overrides._
2. Mutation uses a copied sandbox with the declared private/generated exclusions
   and cannot enable the constrained E2E provisioning marker.
   _Enforcement: script:scripts/check-mutation-scope.mjs — rejects in-place mutation, changed exclusions, shared setup, and the provisioning marker; S2 qualifies the copy behavior._
3. Every selected source and test belongs to the checker project, whose
   compiler options match the integration project.
   _Enforcement: script:scripts/check-mutation-scope.mjs — parses both TypeScript projects, requires selected-file membership, and compares compiler options._
4. Ordinary verification runs scope checks, while mutation campaigns remain
   opt-in with informational scores and propagate execution failures.
   _Enforcement: test — test/unit/scripts/check-mutation-scope.spec.mjs and test/unit/scripts/check-test-discovery-boundaries.spec.mjs check command reachability, generated-file isolation, workflow triggers, score policy, and execution-error propagation._

**3 of 4 verified wired, 1 cited, and 0 resting on review**.
Invariants 1–3 have wired script checks; invariant 4 has cited test coverage.

## Acceptance scenarios

| ID  | Scenario                                                     | Required result                                                                            | Coverage                                                                                                   |
| --- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| S1  | A selection is empty, stale, broadened, or overridden        | The command rejects it before mutation; actual discovery equals the four-suite allowlist   | test:0040/S1 — scope validator fixtures and real Vitest discovery                                          |
| S2  | Dummy private/generated files coexist with a public sentinel | A disposable Stryker sandbox excludes the private sentinels and copies the public sentinel | review — explicit sandbox qualification, also run by manual CI                                             |
| S3  | Mutants change meaningful harness decisions                  | Added behavioral assertions kill selected baseline survivors                               | test:0040/S3 — independent timeout override expectations and focused regressions; compare campaign reports |
| S4  | Ordinary verification or automatic CI runs                   | Scope checks run without a mutation campaign; mutation scores have no failure threshold    | test:0040/S4 — command reachability and workflow trigger checks                                            |
| S5  | A developer and manual CI run the final campaign             | Both complete with reports, measured runtime, and separate status counts                   | review — linked local/CI campaign evidence and triage below                                                |

## Relationship to architecture work

This pilot sits apart from the separate architecture-check work, which remains
independently closable. Its transferred I1–I8/S1–S12 requirements are not qualified
by this harness campaign. In particular, mutation scores do not measure I8's reduction
in required source/test/contract context across workflow-family changes.

Architecture-check defects stay with that separate work. Any later production campaign should
follow the established per-workflow persistence-before-consumer sequence and name its
own scope, cost, and behavioral evidence. This RFC does not duplicate the retired
architecture draft or add a new requirement to those refactors.

## Pilot outcome

Qualification completed on 2026-09-11 with Node 22.23.2, Yarn 1.22.22, Stryker
core/Vitest runner/TypeScript checker 10.0.0, Vitest 4.1.11, and TypeScript 5.9.3.
The baseline restores the original four test files from
`625127adb502fa672d7a3aa9adffc4921b7b872a`. Baseline and final campaigns use
identical mutated source contents, runner/checker configurations, and lockfiles,
including the static-activation correction. Configuration-only improvements
are therefore excluded from the assertion comparison.

| Campaign    | Commit       | Tests | Command wall time |
| ----------- | ------------ | ----: | ----------------: |
| Baseline CI | 0175c2414ccf |    68 |           648.11s |
| Final local | c6527f4cb63b |   129 |          448.149s |
| Final CI    | 91cc3921f62f |   129 |           661.72s |

| Campaign           | Generated | Killed | Survived | CompileError | NoCoverage | Timeout |
| ------------------ | --------: | -----: | -------: | -----------: | ---------: | ------: |
| Baseline           |       721 |    192 |      120 |          157 |        239 |      13 |
| Final local and CI |       721 |    301 |       45 |          157 |        203 |      15 |

Every final local/CI mutant identity and status matched. All three campaigns
had zero `RuntimeError`, `Pending`, and `Ignored` results. Added assertions
killed 79 baseline survivors and 30 previously uncovered mutants; all 192
original kills and all 157 compile-error classifications remained unchanged.
Two additional baseline survivors now time out and are not credited as
assertion kills. Stryker's informational score changed from 36.35% to 56.03%;
it counts timeouts as detected and excludes compile errors. The
triage
recorded behavioral examples and dispositions for all remaining
survivors, uncovered mutants, and timeouts.

Both manual jobs used the repository's `anycloud-lambda` backend and finished
within the 20-minute limit: 11m 28s baseline and 11m 36s final, including setup
and report upload. The final local campaign overlapped ordinary verification
at startup; these are observed wall times, not isolated performance benchmarks.
`yarn verify` at `c6527f4cb63b` passed all checks and 9,087 tests in 366 files
in 224.435s. Actual pilot discovery matched exactly four suites. The disposable
qualification excluded 17 private/generated sentinels, copied its public
sentinel, and killed its static Boolean mutant locally and in CI; its separate
compile-error fixture was not counted as an assertion kill.

GitHub's [manual-dispatch requirement](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)
prevents dispatching a new workflow filename before it exists on the default
branch. Qualification used temporary validation branches with the already
registered `style.yml` entrypoint containing the exact `mutation.yml` bytes.
The final CI commit differs from the qualified local code only by that entrypoint
copy; the PR preserves the ordinary Style workflow. The final HTML/JSON
artifact
is retained until 2026-09-18 07:54 UTC. After merge, developers dispatch
`mutation.yml` directly.

Two implementation findings changed the initial runner plan. The full
integration-project probe at `60264c525b763aaa4e926c4203310d484ea553c2` was
stopped after 3,363.081s (56m 3s), without a complete report. An early scoped
run with two concurrency tokens took 1,626.584s (27m 7s) while overlapping
that probe. The qualified project inherits integration compiler options and
narrows its roots; ordinary verification still checks the entire integration
project. Full-project and scoped per-mutant diagnostics have not been proven
equivalent. Four tokens provide two checkers and two mutation runners.
Separately, the Stryker `testFiles` static-activation defect required moving
the explicit suite selection entirely into Vitest and requalifying the
unchanged assertions before comparing results.

## Decision

Proposed for maintainer review.
