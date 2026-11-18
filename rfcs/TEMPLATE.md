# RFC NNNN: <title>

> Status: Proposed
> Date: YYYY-MM-DD
> Author: <name>

Use short answers; omit empty optional sections. Follow the material decision
guidance in [CONTRIBUTING.md](../CONTRIBUTING.md#code-quality).

## Summary

One paragraph: the problem, proposed change, and why it matters. Link relevant
code/docs.

## Proposal

- **Smallest useful release:** Who can do what when this ships? What is explicitly
  excluded?
- **Implementation choices:** Explain material choices and trade-offs beside the
  relevant proposal. For material additions, what concrete need cannot be met by
  existing mechanisms?
- **Accepted limitations:** Which failures require manual intervention? What
  concrete evidence would justify adding the deferred automation?

## Required invariants

_(Optional — rules this release must keep true. Exclude deferred ideas and
annotate each entry with its enforcement layer; see [RFC 0025](./0025-enforcement-ledgers.md).)_

1. One testable sentence.
   _Enforcement: review — why no mechanism exists yet._

## Acceptance scenarios

_(Optional — observable release requirements. Deferred ideas do not gate release.
Fill `Coverage` in the implementation PR, with `NNNN/S<k>` in cited test titles;
see [RFC 0025](./0025-enforcement-ledgers.md).)_

| ID  | Scenario       | Required result        | Coverage                  |
| --- | -------------- | ---------------------- | ------------------------- |
| S1  | One situation. | One observable result. | test:NNNN/S1 — which test |

## Alternatives / open questions

_(Optional — consequential alternatives and unresolved decisions or risks that
could change this proposal.)_

## Tracking

As changes ship, link each independently shippable change to its PR.

## Decision

Record the call, date, and approved scope. Link existing rationale; explain any
material departures.
