# RFC 0010: Quota ticket details

> Status: Proposed
> Date: 2026-06-30
> Author: Codex draft
> Updated: 2026-09-10 to narrow the release to ticket visibility.

> Current baseline: The CLI exposes `quota request`, `quota status`, and
> `quota operation <id>`. Provider request details are available in status
> data and JSON output, but `status --details` is not implemented.

## Summary

Add `anycloud quota status --details` and a compact-view hint so operators can
inspect the AWS/Azure provider requests and tickets already returned by quota
status. This release makes existing information visible without adding quota
commands, provider calls, persistence, or API shapes.

## Context / problem

The current workflow has three surfaces:

- `quota request` starts provider quota increases through a local operation worker.
- `quota status` prints a compact region x quota-group matrix.
- `quota operation <id>` shows local submission progress.

The matrix hides submitted timestamps, case IDs, provider request IDs, and URLs
unless the user chooses `--json`. Documentation tells users to check status
after requesting quota, but the normal text view omits the provider ticket path.

The implementation attaches to `src/cli/commands/quota.ts` and reuses
`QuotaStatusEntry` from `src/shared/api-contract/quota-schemas.ts`. Existing
provider mappings in `src/api/services/quota/` already supply the available
request metadata.

## Proposal

- **Smallest useful release:** Operators can inspect visible quota requests and
  follow their provider ticket links. History/show commands, usage/headroom,
  new filters, request controls, and GCP parity are excluded.
- **Simplest implementation:** Render existing status entries using the same
  filtering and latest-per-cell selection as the compact matrix. No new DTO,
  endpoint, provider query, or durable record is needed.
- **Accepted limitations:** Older requests and missing provider fields still
  require the provider console or CLI. This change adds visibility, not request
  recovery or historical reconstruction.

```bash
anycloud quota status --details
```

Default `quota status` stays compact. If visible request entries exist and
`--details` is not set, print:

```text
Ticket details hidden in compact view. Run: anycloud quota status --details
```

`--details` prints the matrix first, then a `Tickets` section for visible
request entries:

```text
Tickets
1. us-east-1 - G/VT GPUs - CASE_OPENED
   Requested 384
   Case      1234567890
   Provider  abcdef12
   Submitted 2026-06-30T18:12:00.000Z
   URL       https://support.console.aws.amazon.com/support/home#/case/?displayId=1234567890
```

Include these fields when present:

- previous, requested, and granted limits;
- case/ticket ID, provider request ID, and a distinct provider case ID;
- submitted/requested timestamp, URL, and note/message; and
- local operation ID and target ID for `source: local_operation`.

Summary counts, matrix cells, the hidden-details hint, and detail rows use the
same latest-per-cell deduplication and existing credential, region, and quota-type
filters. Current-limit-only entries produce neither ticket rows nor a hint.
`--json` continues to emit filtered raw entries without a text hint or section.

## Deferred work

These ideas are outside this release and its acceptance checks:

| Idea                                       | Evidence that would justify revisiting it                                                                         |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| History/show commands and request filters  | Operator investigations repeatedly need requests absent from current status, requiring manual provider lookup.    |
| Usage/headroom                             | Recorded provisioning investigations cannot be resolved from current limits and need remaining-quota information. |
| Explicit desired values or request reasons | Actual quota cases cannot be handled by the existing computed request flow.                                       |
| GCP quota parity                           | A customer needs an AnyCloud-managed GCP quota workflow and the provider mapping is qualified.                    |

New DTOs or endpoints need an accepted scenario that the existing status data
cannot support. Native CLI feature parity alone does not justify them.

## Tests

Verify the release through CLI rendering and command coverage:

- compact status includes the hint only when visible request entries exist;
- details preserve available AWS case and Azure ticket identifiers and links;
- missing optional metadata is omitted without invented values;
- current-only entries produce no ticket section or hint;
- existing filters and latest-per-cell selection agree across matrix and details;
- local-operation entries retain their operation and target IDs; and
- JSON output remains unchanged.

## Documentation

When this ships, update `docs/reference/cli/quota.md`, `docs/platform/jobs.md`,
and `docs/troubleshooting.md` to show the supported flow: request quota, inspect
status, then use `quota status --details` for provider tickets/cases. Describe
only metadata present in the response; older history remains a provider-console
or CLI task.

## Alternatives considered

- **Keep JSON as the only drilldown:** already exposes the data, but leaves the
  ordinary text workflow unable to show users their provider ticket path.
- **Add a separate `quota tickets` command:** adds another command for the same
  filtered entries; a detail flag fits the existing status workflow.
- **Deliver native CLI parity together:** bundles independent workflows and API
  changes with a visibility fix. Defer them until the evidence above exists.

## Risks & caveats

Provider metadata varies. Preserve native identifiers and omit unavailable
fields rather than fabricating parity. The latest-per-cell view remains a
current summary, so an older request can still require manual provider lookup.
The renderer must use the existing selection once so details and summary counts
cannot disagree.

## Decision

Scope approved on 2026-09-10: `quota status --details` and its compact-view hint,
using existing status data and preserving JSON output. Broader quota parity and
new DTOs/endpoints are deferred. The RFC remains Proposed pending implementation
and acceptance of this release.
