# RFC 0023: Error serialization boundaries

> Status: Accepted
> Date: 2026-08-24
> Author: Claude draft
> Outcome: Implemented on 2026-08-26.

## Summary

An error crossing a boundary is shaped by that boundary's constraints, and the
two boundaries here have opposite ones. A log line wants everything — stack,
cause, nested detail. A workload event is a row written once per retry and
kept forever, so it wants a bounded, known set of fields.

The persisted boundary therefore **allow-lists**: `errorForDiagnosticMetadata`
copies `message`, `name`, and named scalar fields, and copies nothing else. The
types make the alternative unrepresentable — a persisted `error` field is a
`PersistedError` or a string, never a raw `Error`.

## Context

A workload step that failed recorded no readable reason.

A container exit replaced the whole metadata object with the container status
rather than adding to it, so the message, diagnosis, disposition, and errorKind
went together and the event carried no `error` key at all. A hosted API refusing
to boot cycled nine times through the full pipeline recording only
`failedAtState: starting`. Detection worked. Retry worked. The reason was
discarded on the way to the event, so an operator saw a workload that would
not start and nothing about why.

Nothing declared the rule that kept the other paths working. `redactValue`
normalizes an `Error` to `{ message, name }` and runs in every event writer but
one, so the store was protected by a redaction helper doing double duty rather
than by a stated contract — and one writer, the Queued event at
`workload-store.ts:2015`, sat outside that accident entirely.

### Why the tests did not catch it

The tests asserted the object handed to a spy, not the value that survived being
written. `expect(spy).toHaveBeenCalledWith({ error })` passes whether or not
`error` serializes to anything. They stayed green for as long as the stored
value was empty.

For anything persisted, assert on read-back.

## Goals

- One serializer per boundary, chosen for that boundary's constraints.
- The persisted one fails closed: an unregistered field cannot reach a row.
- Types that reject a raw `Error` at a persistence boundary.
- Tests for persisted values that read them back rather than inspecting call
  arguments.

## Non-goals

- Changing how errors are classified. The diagnosis and disposition model is
  sound: a typed diagnosis driving state routing worked correctly throughout the
  incident above. Only the reason was lost.
- A single sweep over the 95 log sites that hand-roll message extraction. They
  are redundant and lossy but not broken; see Rollout. (Done separately since,
  along with the log-side cap this deferred.)
- Changing `LogMetadata.error`, which is deliberately `unknown` because the
  logger accepts a string or an `Error` and serializes accordingly. That
  asymmetry is correct: logging is forgiving, persistence is not.

## Rules

**Persisted error fields are typed.** A field whose value is written to SQLite,
a bucket, or any other durable store declares `error?: PersistedError | string`,
never `unknown` and never `Error`. Callers serialize at the call site.

**The persisted boundary allow-lists.** `errorForDiagnosticMetadata` copies
`message`, `name`, and named scalar fields, and nothing else. A `stack` is never
copied because nothing lists it; a nested object cannot be copied because only
scalars are. A new error class is safe on the day it is written, with no
strip-list to update.

The cost is real and deliberate: a genuinely useful new field is dropped until
someone adds it to `DIAGNOSTIC_SCALAR_FIELDS`. For a row written once per retry
and kept forever, losing by default beats leaking by default — and the logger
still captures the whole error.

**An exception names its reader.** Where a specific non-scalar field genuinely
has to survive, keep it explicitly and say who reads it. `VMCreationError` and
`PartialVMCreationError` retain `attemptedVmIds` and `partialVMs` while dropping
`originalError`, the one field that is actually unbounded — the provider's SDK
request/response graph. `attemptedVmIds` is read back out of the persisted event
by an end-to-end check that every retry used a fresh VM name, guarding against
Azure rejecting a create as a duplicate. An allow-list would drop that array and
leave the check comparing zero against zero: passing, and no longer checking
anything.

An exception with a named reader is a design. One without a named reader is
debt, and should be deleted rather than documented.

**One serializer per boundary.** `errorForDiagnosticMetadata` for persisted
metadata; `serializeError` inside the logger, where a stack is wanted.

**The cap lives in the serializer.** `MAX_PERSISTED_ERROR_MESSAGE_CHARS` is
applied inside `errorForDiagnosticMetadata`, not at each call site, so no
boundary can forget it and no second copy can drift.

**Type-specific detail merges, never replaces.** An error class carrying extra
structure — `ContainerExitError` carries container state, exit code, OOM kill,
and a log tail — contributes those fields on top of the standard envelope.
Replacing the envelope on an `instanceof` check silently removes every field
later added to the standard shape.

**Persisted values are asserted by read-back.** A test that cares what was
stored reads the row and parses it, using `latestEventMetadata()`. Asserting the
argument passed to a writer proves the call happened, not that the data
survived — and a suite that mocks persistence cannot tell the difference.

Spying is still right for routing. Whether `publishTerminalOutcome` was called
with `Invalid` rather than `Retrying` is a fact about the call, and a mock is the
tool for it. The line is content: what the row holds is asserted against the
row.

## Alternatives considered

**One general serializer everywhere (`serializeError`).** Attractive because the
logger already uses it and `serialize-error` is already a dependency. Rejected
on measurement: `serializeError` exposes `stack` enumerably, and a V8 stack
repeats the whole `name: message` line first, so a 50,000-character message
produces a 50,335-character stack and a 52kb event however tightly `message` is
capped. It also copies constructor parameter properties, so
`ContainerExitError`'s status — including the `docker logs --tail 100` string —
lands in the row a second time. Both follow from it being built for a boundary
that wants everything.

**A deny-list: general serializer, then strip the dangerous keys.** Rejected
because it fails open. Stripping `stack` and `metadata` by name holds only until
an error class arrives carrying something nobody listed; a plausible
`ImagePullError` holding a manifest puts 31kb in every event, and the strip-list
is not updated for a class that did not exist when it was written. The
allow-list version of that test passes without any code change, which is the
whole difference.

**Rely on `redactValue`.** It already normalizes an `Error` to
`{ message, name }` and already runs in nearly every writer, so this is close to
free. Rejected because it is an accident of redaction rather than a declared
contract: a reader cannot tell from a call site whether the reason will survive,
and one writer already sits outside it. Depending on it would make the Queued
writer a silent exception rather than a known gap.

**Persist the raw `Error` and let the writer sort it out.** This is what the
code did. Rejected because an `Error`'s own fields are not enumerable, so any
writer that does not redact stores `{}`, and whether a given writer redacts was
never something a call site could see.

**A hand-rolled `{ name, message }` at each site.** Rejected because parallel
shapes drift, producing two different records of the same failure and two places
to fix when the shape changes.

**Make `redactValue` allow-list too.** It is the last place a raw `Error` can
arrive, and it copies `message`, `name`, and then every own enumerable field —
31kb for an error class carrying a manifest, the same fail-open shape rejected
above. Routing it through `errorForDiagnosticMetadata` would leave one
normalization rule instead of two.

Rejected on evidence. `redactValue` serves the logging boundary as well as the
persisted one, and breadth is the point there: a cloud SDK error carries its
diagnosis in fields no allow-list would name — AWS uses `Code`, `$fault` and
`$metadata` — and a `cause` chain is an `Error`, not a scalar. Existing tests
pin all of those, and an allow-list drops every one. The persisted boundary does
not need the help: its serializer bounds the row and its types reject a raw
`Error` before it can arrive.

The investigation did surface a real defect in that branch, since fixed:
`message` and `name` are not own-enumerable, so the loop that redacts the
remaining fields never saw them, and a secret in an error message was copied out
verbatim.

**A lint rule instead of types for the production boundary.** Rejected because
the constraint is expressible in the type system, and a custom rule would be
machinery maintained to catch what the compiler rejects outright. Lint is used
only for the half the compiler cannot see — see Enforcement.

**Full `tsc` over the specs instead of a targeted lint rule.** This would enforce
both halves of this RFC and is worth more than the rule. Deferred, not rejected:
scoped to `test/unit/**` with `rootDir: "."` and `noEmit`, the project reports
874 errors, predominantly TS2739, TS2740 and TS2353 — partial fixtures
constructing objects where a full type is expected. That is the accrued cost of
never having checked, not latent breakage, and it is its own piece of work.

## Enforcement

Types where the compiler already looks. Typing the `workload_events` metadata
entry points makes every unserialized error a compile error in production code,
with no lint machinery to maintain.

That covers half of it. Specs are not type-checked, so the same change does not
stop a test asserting the shape that never survives being written.

`@typescript-eslint/no-base-to-string` is enabled for `src/api`. It catches
`${error}` and string concatenation producing `[object Object]`, which is the
same loss at a different boundary.

### The unenforced half

Nothing type-checks `test/unit/**`. `verify` covers `src` through `build`, and
`test/integration`, `ci/canary` and tooling through `style`; the unit specs are
checked by no configuration. `tsconfig.test.json` exists and would cover them,
but no script invokes it, and it cannot load — it inherits `rootDir: "src"`
while including `test/**`, so every spec raises TS6059.

That is why the defect survived. A spec can hand a raw `Error` to a mock
indefinitely, because no compiler reads it.

The tooling to close this is already here and already applied elsewhere. ESLint
runs `recommendedTypeCheckedOnly` with `projectService: true` over `e2eFiles`,
and it builds its own program — type-aware rules do not require the files to
pass `tsc`. `eslint-plugin-local` holds twenty-two rules of this genre, several
governing spec shape directly (`valid-e2e-spec-shape`, `require-e2e-fixture`,
`no-skipped-or-focused-tests`). Existing violations are grandfathered through
`ignores` lists so a rule binds new code without a repo-wide cleanup first.

So `test/unit/**` was never wired into machinery that already existed, rather
than the enforcement being impossible.

`local/no-raw-error-in-persisted-metadata` is keyed on the persisted-metadata
shape rather than on assertions generally, and resolves an identifier to its
declaration rather than trusting its name. Both are necessary to keep it quiet:
`expect(onError).toHaveBeenCalledWith(error)` is a correct assertion, and a
variable called `error` usually holds an already-serialized value. It reports
nothing repo-wide, so no grandfathering list was needed.

## Rollout

Shipped. `errorForWorkloadEvent` delegates to `errorForDiagnosticMetadata`, so
every event writer shares one allow-list and `task.ts` no longer holds a
serializer of its own. The cap moved inside it and its non-`Error` branch keeps a
thrown object's fields. Container detail merges into the standard envelope rather
than replacing it. `WorkloadEventMetadataInput.error` is a `PersistedError` or
a string, so a raw `Error` is a compile error at every writer.
`latestEventMetadata()` makes read-back the shorter assertion,
`local/no-raw-error-in-persisted-metadata` catches the specs no compiler reads,
and `no-base-to-string` is on for `src/api`.

Three tests pin the properties rather than the implementation: a
50,000-character message stays under 4kb, a container log tail appears exactly
once, and a class carrying an unregistered field cannot leak it.

Remaining:

Nothing outstanding. All seven `workload_events` writers now redact before
storing; two did not. Neither could receive an error — one builds its metadata
from two local strings, the other from a single formatted message — but both
embedded a caller-supplied agent-session identifier and stored it verbatim.

The second was missed on a first pass because the check grepped for the shape
the other writers used. Enumerating the writers, rather than matching a
pattern one of them happened to have, is what found it.

The log sites that write `error: e instanceof Error ? e.message : String(e)`
were left to opportunistic cleanup, on the reasoning that a large mechanical
diff is easy to get subtly wrong. That was right about the risk and wrong about
the size: the real population was 182 sites in `src/`, not 95, and eight files
had already reinvented `errorMessage` as a private helper — so a blind
substitution turned each into a self-call. The type checker caught every one.

They are now converted. Sites assigning to a log's `error` field pass the error
itself; the rest use `errorMessage()`. `local/no-hand-rolled-error-message`
holds the line, because "new code should pass the error" had been the
documented advice on `errorMessage` while it sat at zero adopters.

That sweep also closed the one exposure this RFC named and did not fix: the log
boundary keeps `stack`, which nothing downstream measured. `boundLoggedError`
caps message and stack on the way out, the same argument as
`MAX_PERSISTED_ERROR_MESSAGE_CHARS` with room for what a log exists to carry.

## Tracking

- Persisted error allow-list, typed event boundary, read-back tests, and
  enforcement.
- Tree-wide log-boundary cleanup and bounded logged errors.

## Decision

Accepted retrospectively on 2026-08-26 based on the shipped implementation.
Persisted diagnostic errors use a bounded scalar allow-list and reject raw
`Error` values at typed write boundaries; logs retain richer error structure
through their own bounded serializer. Boundary-specific serializers are the
decision—the two representations are deliberately not unified.
