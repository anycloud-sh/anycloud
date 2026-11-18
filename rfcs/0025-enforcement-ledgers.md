# RFC 0025: Enforcement ledgers for stated invariants

> Status: Accepted
> Date: 2026-08-26
> Author: Claude draft

## Summary

An RFC that states invariants must also state, per invariant, the mechanism
that enforces it — a type, a lint rule, a boundary script, a runtime guard, a
test, or an honest `review` — and `yarn check:rfc-ledgers` must reject a claim
whose mechanism does not exist. RFC 0017 already works this way; this RFC makes
the practice a convention for every RFC that states invariants, fixes the
vocabulary, and sets the order of preference between mechanisms.

The ledger itself catches nothing. It is accounting: it makes an invariant
with no chokepoint countable, so the absence of a mechanism stops reading like
its presence. The mechanisms it names do the catching.

The same treatment extends to acceptance scenarios: for RFCs registered with
the validator, every scenario row names the test, review reason, or deferral
behind it.

## Context / problem

The repository's RFCs state invariants; almost nothing connects them to the
mechanisms that hold them. Five RFCs carry an invariant section — 0014, 0015,
0016, 0017, and 0018 — and only RFC 0017 annotates one. Its ledger, validated by `scripts/validate-rfc-ledgers.mjs` in `yarn style`,
records each core invariant's enforcement layer. RFC 0015 states 24 required invariants and records the
enforcement of none.

That gap is not cosmetic. An invariant with no mechanism reads exactly like one
with three, so the step from "stated" to "unrepresentable" is nobody's job, and
nothing surfaces when it is skipped. Recent production defects sat on rules
RFC 0015 had already ratified:

- _"`ended_at` is written only after provider teardown is confirmed"_ — yet a
  capacity VM's ledger row could be ended while its Kubernetes Node object
  survived, stranding CoreDNS on a stale Node until a later fix landed.
- _"Capacity VM network ports are reachable only from members of the same
  resource scope"_ — yet the GCP adapter omitted a firewall priority at one
  call site and an IP-family split at its neighbour, each a
  divergence between two correct implementations of the same stated rule.

The week RFC 0017 gained its ledger, the annotation caught its own record wrong
twice: invariant 8 was tagged review despite being enforced since an earlier
change, and invariant 12's completeness gap became a three-observation
`release()` fix.
The play works; it has only been run once.

Two smaller defects block running it everywhere. The vocabulary (`type`,
`lint:<rule>`, `runtime`, `test`, `review`) cannot name a boundary script —
`yarn check:boundaries` chains ten of them, and RFC 0015's one
already-enforced invariant (_"gateways receive only an opaque cloud-resource
scope"_) is held by `scripts/check-cloud-resource-boundaries.mjs`, so the free
win is unrecordable. And the rollup sentence the RFC tells readers to watch is
hand-maintained prose the validator prints but never asserts.

## Proposal

### The convention

An RFC that states invariants — a `## Required invariants`, `## Core
invariants`, or `## Required invariants and tests` section — annotates every
entry with exactly one enforcement tag. Having the section is the opt-in;
there is no separate registration step.

Each entry reads:

```
1. The invariant, stated as one testable sentence.
   _Enforcement: <tag> — <explanation>._
```

### The vocabulary

One tag per invariant, from a closed set:

| Tag             | Claim                                 | Validated as                                                                                       |
| --------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `type`          | the mistake does not compile          | the named path exists                                                                              |
| `lint:<rule>`   | ESLint rejects it                     | rule exported by `eslint-plugin-local/index.mjs` and referenced in `eslint.config.mjs`             |
| `script:<path>` | a repository policy script rejects it | the file exists and a `package.json` check script invokes it                                       |
| `graph:<rule>`  | the dependency graph rejects it       | a statically named rule in `.dependency-cruiser.cjs`, with the graph check wired in `package.json` |
| `runtime`       | production code refuses at run time   | the named path exists                                                                              |
| `test`          | a required spec fails                 | the named path exists                                                                              |
| `review`        | nothing mechanical; humans hold it    | the annotation carries a reason                                                                    |

`review` is a legitimate terminal answer for a rule that compares meanings
rather than shapes, but it must say why.

### The preference order

Prefer a type that makes the mistake impossible over a lint rule; prefer a
lint rule, a boundary script, or a graph rule over a runtime guard; prefer a
runtime guard over a test. Lint rules, boundary scripts, and graph rules rank
together: all are static, and none is suppressible at the point of violation
— `yarn check:policy` runs before ESLint precisely so policy cannot be
disabled inline, and a graph rule has no inline disable at all. This order
was already stated as an acceptance criterion; it is normative here.

A mechanism ships in the same change as the abstraction it guards, and the
annotation ships in the same change as the mechanism. An unvalidated
enforcement claim is the failure this convention exists to prevent.

### Scenario coverage

Invariants are not the only claims an RFC makes. An acceptance-scenario table
promises observable behaviors, and a scenario arm can sit unvisited while
every stated invariant stays green — RFC 0029's implementation review found
exactly that (terminated-while-retrying cleanup, specified in prose and
missed). So scenario tables get the same accounting: a fourth `Coverage`
column, each cell from a closed vocabulary mirroring `_Enforcement:`
annotations:

| Cell                       | Claim                                  | Validated as                                                                                      |
| -------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `test:<NNNN>/S<k> — <why>` | a test exercises this scenario         | the literal token `NNNN/S<k>` appears in a file under `test/`, and it names this RFC and this row |
| `review — <why>`           | humans hold it; no mechanical coverage | the reason is present                                                                             |
| `deferred:<NNNN> — <why>`  | the scenario moved to another RFC      | `rfcs/<NNNN>-*.md` exists                                                                         |

Tests opt in by embedding the token in their titles —
`it('0029/S6 runtime loss retries nonterminal jobs', …)` — grep-able, with no
runner integration, for unit and E2E specs alike.

The gate applies per RFC, through the validator's `SCENARIO_GATED_RFCS`
registry: for a registered RFC, a scenario table without the `Coverage` column
is an error, and every row must carry a valid cell. A table that carries the
column is validated regardless of registration, so any RFC may adopt early.

The registry starts with RFC 0029: its scenario walk is the one the motivating
review had to do by hand. As with annotation retrofit, RFCs whose scenario
tables predate the convention (0030, 0032, 0033) register when next materially
edited.

### Validation

`yarn check:rfc-ledgers` (wired into `yarn style`) validates every annotated
RFC:

- every invariant in the section carries exactly one tag from the vocabulary,
  with an `—` explanation;
- a named mechanism exists and is wired, per the table above;
- file paths named in an annotation exist;
- every acceptance-scenario row in a registered RFC carries a valid
  `Coverage` cell, with each cited test token present under `test/`;
- the document's rollup sentence matches the computed counts, and it
  distinguishes what was actually proved: entries whose rule is verified wired
  (`lint:`, `script:`, `graph:`) from entries whose mechanism is cited and path-checked
  only (`type`, `runtime`, `test`) from `review`. A flat "N of M mechanically
  enforced" overstates — RFC 0017's original 13 of 16 resolved to 6 lint
  entries naming 4 distinct wired rules, 7 cited-only entries, and 3 review.

The validator initially hardcoded RFC 0017's section shape; a later change
generalized it and annotated RFC 0015 in the same change.

### Status does not gate annotation

A `Proposed` RFC may carry annotations. The ledger records what is enforced
now, independent of whether the design is ratified. RFC 0015 is the motivating
case: four of its five delivery stages have shipped and its acceptance is
gated on live qualification, while its 24 invariants already govern
production code today.

### Scope and retrofit

Retrofit is lazy. RFC 0015 and RFC 0017 are annotated; RFCs 0014, 0016, and 0018 are annotated when next materially
edited, not in a dedicated pass. New RFCs inherit the convention from
`TEMPLATE.md`, which now prompts for the section — 0022, 0023, and 0024 all
shipped without an invariant section, so the template, not the README, is
where the convention reaches authors.

Number allocation, the other prerequisite for a ledger keyed by RFC number, is
recorded in `rfcs/README.md`: numbers are claimed at pull-request open, and
colliding drafts renumber before merge.

## Required invariants

1. Every invariant in an annotated RFC carries exactly one tag from the
   closed vocabulary, and a named mechanism exists and is wired.
   _Enforcement: script:scripts/validate-rfc-ledgers.mjs — every RFC in the
   validator's annotated list is parsed, and each named mechanism must exist
   and be wired._
2. An annotated RFC's rollup sentence matches the computed enforcement counts.
   _Enforcement: script:scripts/validate-rfc-ledgers.mjs — the rollup is
   regenerated from the annotations and must appear in the document verbatim._
3. A new RFC that states invariants annotates them from birth.
   _Enforcement: review — `TEMPLATE.md` prompts for the annotated section, but
   a new RFC must also be added to the validator's annotated list, and nothing
   detects an invariant section outside it._
4. Every acceptance-scenario row of a registered RFC carries a valid coverage
   cell.
   _Enforcement: script:scripts/validate-rfc-ledgers.mjs — scenario tables in
   the validator's registry are parsed, each cell must come from the closed
   vocabulary, and a cited test token must appear under `test/`._

On 2026-09-01 that is **3 of 4 verified wired, 0 cited, and 1 resting on
review**: invariant 3.

## Alternatives considered

### Amend `rfcs/README.md` and `TEMPLATE.md` only

The cheapest option, and the fallback if the convention never spreads past
RFC 0015. Rejected because the decision has real alternatives and binds every
future RFC author; the README records conventions, not the reasoning that
chose them, and that reasoning's current home — a tracking issue body — is
one that closes.

### One tracking issue per RFC, no convention

A tracking issue worked for RFC 0017, and a sibling issue is still the right
tracker for RFC 0015's backlog. Rejected as the only mechanism because issues close and
drift out of sight; the invariant sections are read where the rules are
stated, and the validator runs on every push.

### Annotate nothing; rely on review

The status quo. Rejected on the evidence above: production defects on
stated-but-unenforced RFC 0015 invariants, against a one-week-old RFC 0017
ledger that had already caught its own record wrong twice.

### Retrofit all five RFCs at once

Rejected for cost and stall risk: 0014, 0016, and 0018 hold dozens of
invariants whose mechanisms would each need archaeology, and none of them is
where the current defects live. Lazy retrofit reaches them when they are next
touched.

## Risks and caveats

- **The validator proves existence and wiring, never sufficiency.** RFC 0017's
  invariant 1 cites `lint:valid-e2e-contract-spec`; nothing ties that rule's
  behavior to the invariant's sentence. Every rollup number is an upper bound,
  and an invariant can be enforced and still name the wrong observation. The
  instance is live: an earlier change rewrote RFC 0015's proposal body to
  "deletes the obsolete Kubernetes Node after its provider VM is confirmed
  gone" and left its invariant reading "drains a Node before terminating its
  VM", so the document contradicted itself until a later change synced the
  invariant — drift the annotation pass itself surfaced. Whether a mechanism
  matches its sentence is review, permanently.
- **Provenance is free text.** PR references are validated for shape only, by
  design. Four days after the ledger landed, two of RFC 0017's thirteen
  citations were already wrong: invariant 12 credited the wrong change for the
  `release()` fix it names, and invariant 10 cited a correct PR plus a
  nonexistent one for a rule that actually landed elsewhere, with its scope
  corrected later still. The ledger reproduced the defect signature it exists
  to count — a correct rule, misapplied at one entry — and stayed green. A
  later change corrected both; the class stays review.
- **`review` is an escape hatch.** A reason is required, but a lazy reason
  passes validation. The rollup makes the count visible; it cannot make the
  choice honest.
- **Annotations add merge surface.** Two changes touching the same invariant
  list conflict. Accepted: the list is where that conflict should surface.

## Tracking

- Generalize the validator to every annotated RFC — parameterized section
  shape, the `script:` tag, and the differentiated rollup assertion — and
  annotate RFC 0015's 24 invariants in the same change. That change also
  corrects RFC 0017's two wrong provenance citations (invariants 10 and 12)
  and syncs RFC 0015's Node-removal invariant with the delete-after-confirmed
  behavior its own body has recorded since an earlier change.
- RFC 0015's sibling backlog completed through several follow-up PRs. The
  resulting validated rollup is 2 of 24 invariants
  verified by wired enforcement, 14 with cited mechanisms, and 8 explicitly
  resting on review.

## Decision

Accepted 2026-08-26. RFC 0017's ledger validated the play; run it
as a convention rather than a one-off.

## Change log

- **2026-09-01:** Added the scenario-coverage convention: acceptance-scenario
  tables in registered RFCs carry a validated `Coverage` column, armed by the
  mandated tracking swap. The registry starts with RFC 0029.
- **2026-11-17:** Before open-sourcing, annotations no longer cite the change
  that landed them, and registration alone gates a scenario table: issue and
  PR numbers don't carry over to the public repository.
