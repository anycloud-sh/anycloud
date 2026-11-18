# Refactor move mutant parity

This check verifies that a
refactor which moves `src/` code keeps the moved code guarded. Stryker mutates
the moved symbols twice, in their old file at the parent commit and in their
new home at the refactor commit, and the comparison lists every mutant that was
detected before and is not detected after. The check is opt-in and not part of
`yarn verify`. It is separate from the [E2E harness pilot](../mutation/README.md)
and its scope guard.

## Plan

A plan in [`plans/`](plans/) names the `base` commit (the refactor's parent),
the `head` commit, each move's old and new file with its symbols, and the specs
for each side. A symbol is a top-level function, class or variable, or a class
member written `Class.member`. Write `["OldClass.member", "NewClass.member"]`
when the move renames it. A named symbol missing on either side is an error.
`"symbols": "*"` selects every symbol of the new file, and those may be new at
head. List every spec that imports or mocks the old or new module on its side,
not only the moved spec files: a spec that mocks the new home can hide the
moved code from tests that used to reach it. Write `["old", ["new1",
"path:new2"]]` when a move splits a symbol, where `path:` names a part in
another file. A symbol mapped twice on one side is an error. Write commits as
full SHAs, so the workflow can fetch them.

## Run

```bash
yarn test:mutation:src-parity test/mutant-parity/plans/1475.json
yarn test:mutation:src-parity test/mutant-parity/plans/1475.json compare
```

Pass `base`, `head`, `rerun` or `compare` to run one step. Run one side at a
time, and never beside another Stryker run or `yarn verify`: timeouts count as
detected, so both sides use the same concurrency and timeouts, and the report
records each side's duration, host load and host. The dry run gets a minute
per six specs of the larger side, and at least five.

The `rerun` step, which `all` includes, reruns every mutant killed before and
surviving after on both sides, on one host, with `--mutate` narrowed to those
nodes: a slower host can turn a timing-dependent kill, such as a `vi.waitFor`
timeout, into a false loss. `compare` then drops a candidate the rerun has
undetected at base or detected at head.

The [Mutant Parity workflow](../../.github/workflows/mutant-parity.yml) runs
plans in CI. Dispatch it with the full SHA of a pushed commit holding the plans,
and, in `targets`, the plan names or a PR number, which selects `<pr>.json`
and `<pr>-*.json`:

```bash
gh workflow run mutant-parity.yml -f source_sha=<sha> -f targets=1485
```

Every plan's sides run in parallel on separate runners. A compare job per plan
then downloads both sides and runs `rerun` and `compare` itself, so the rerun
still runs both sides on one host. The run summary shows each report, and the
`implementation-evidence-mutant-parity-<plan>-<side>` and `-compare` artifacts
keep the Stryker reports, reruns and `report.md` for 30 days.

For each side, the runner extracts the commit with `git archive` into
`reports/mutation/src-parity/<plan>/<side>-tree` (ignored, and removed
afterwards). It resolves the symbols to line ranges with the TypeScript
compiler and runs `stryker.src.config.mjs` on exactly those ranges.
`vitest.src-mutation.config.mjs` adds the plan's specs to the ordinary unit
setup through `MUTATION_SPECS`.

Every run leaves out the specs that can't pass in Stryker's dry run.
`test/unit/ci/`, `test/unit/eslint-plugin/` and `test/unit/scripts/` are left
out whole, since their architecture and policy specs, such as the module graph
and size ceilings, read the real tree, which the sandbox replaces with
instrumented copies. `test/unit/services/notifications-config.spec.ts` points
`HOME` at a temporary directory, which `os.homedir()` ignores in Stryker's
worker threads, and `test/unit/e2e-api-routing.spec.ts` starts the built API,
which the sandbox lacks.

## Scores and floors

The `score` step mutates a whole file at `HEAD` against every unit spec that
imports or mocks it, directly or through other `src/` or `test/` modules, in
`<n>` chunks cut where a top-level declaration or class member starts:
`yarn test:mutation:src-parity score <file> <k>/<n>`. Without a file, it merges
the chunk reports into `report.md`: each file's status counts and score
(detected over detected and undetected, as Stryker counts it), a **Below
floor** list, and a **Not scored** list of files with a missing chunk or no
mutants. Both lists are a report, not a failure.

[`floors.json`](floors.json) holds each production owner's floor: the share of
its scored mutants that were killed, rounded down, minus 5. Timeouts count
toward the score but not the floor, because they depend on host load: two of
`credential-auth-failure.ts`'s baseline timeouts survived on an idle runner. A
`null` floor marks a file whose **score** is under 60%. The score counts
killed and timed-out mutants; the floor counts only killed ones. So
`completion.ts`, scoring over 60% with a killed share of 58.95%, gets a floor
of 53. Floors ratchet like the
[owner size ceilings](../../CONTRIBUTING.md#module-structure). When a file's
score improves, raise its floor in that PR to the new killed share, rounded
down, minus 5. When it falls below its floor, add a test, or lower the floor in
the same PR with its rationale. The migration
modules are left out: every database-backed spec runs the migration chain, so a
whole-file run takes 2 to 3 hours.

Dispatched with `-f mode=score`, the workflow scores every file in
`floors.json`, or the space-separated `src/` files in `targets`, in parallel
chunks of about 300 lines, and writes the report to the run summary and the
`implementation-evidence-mutant-score-report` artifact.

## Survivors on a PR's changed lines

The [Mutant Survivors workflow](../../.github/workflows/mutant-survivors.yml)
runs on every ready, same-repository pull request that changes `src/`. It is
advisory: its check stays green and is not required. It runs the `diff` step:

```bash
yarn test:mutation:src-parity diff origin/main
```

The step takes the `src/` lines that `HEAD` changes since its merge base with
the given commit (`git diff -U0`), and mutates only those lines, at `HEAD`,
against the covering specs of each changed file that has mutants, as in
[Scores and floors](#scores-and-floors). Stryker's instrumenter counts the
mutants first. Above 150, which no longer fits the 30-minute job, the step skips
them and recommends a manual dispatch.

`reports/mutation/src-parity/diff/report.md` lists the mutants on changed lines
that survived or had no coverage, in the parity report's order: one line per
node and mutator, literal mutants last, and at most 15 lines. Each line shows
`file:line`, the original code, the mutation and its status. Each changed file
in `floors.json` is listed with its floor and its undetected count, with the
`mode=score` dispatch that checks its whole score.

The mutate job has read-only contents access and no secrets. A separate job,
the only one that can write, downloads the report and creates or updates a
single `github-actions[bot]` comment marked `<!-- mutant-survivors -->`, naming
the head commit. It never checks out or runs the PR's code. A failed or
timed-out run posts a note instead, and a report too long for a comment is
truncated, with the whole report in the run artifact.

## Matching and triage

Mutants pair within the same symbol, mutator and replacement. The first pass
uses the offset from the symbol's name, so moving a declaration or adding
`export` keeps its mutants paired. The second pass pairs the rest by the
mutated source text, ignoring whitespace and trailing commas, in source order.
This handles an edit earlier in the symbol, such as a renamed parameter type,
that shifts every later offset. A text group pairs only when both sides have
the same number of leftovers, so an added or removed copy leaves the group
unmatched. A bare `true` or `false` uses its whole line as its text. A split's
parts pair with the old symbol by text, and by offset only if they keep its
name.

`reports/mutation/src-parity/<plan>/report.md` leads with the unmatched count
and share for each side. If more than 5% of a side is unmatched, not counting
symbols new at head, the report says the matching is weak. It also counts the
unmatched mutants that were detected at base. These are often blocks enclosing
an edited line, which can't pair, so check each one by hand for a loss. It then
lists status counts, each loss (killed or timed out before, survived or
uncovered after) with the test that killed it and its failure, survivors on
both sides per symbol as pre-existing gaps, and every unmatched mutant with its
reason, detected base mutants first: `new at head`, `in a split`, or
`changed code`. The candidates the rerun didn't reproduce follow the losses.
Each list shows one line per node and mutator, with string, array, object and
regex literal mutants last, since they are most often equivalent. A covered
survivor that ran no tests
([stryker-js#6210](https://github.com/stryker-mutator/stryker-js/issues/6210)),
or a report from a commit other than the plan's, is an error.

Triage each loss as a real loss, which a follow-up PR restores; an equivalent
mutant; or behavior only a CLI journey covers, since Stryker runs unit specs
only.
