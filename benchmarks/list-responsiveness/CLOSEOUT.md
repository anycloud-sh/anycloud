# List investigation closeout

The reviewed investigation is complete with no production promotion. The evidence
merge landed as
`7d0373256d23d32f060f4cca021c9da00867230d` on September 17, 2026. The child issue
is closed; its
conditional implementation phase is unnecessary for this completed investigation.
The parent issue remains open for
review and merge of the cleanup.

The [final diagnosis](STATUS-CONTROL-RESULTS.md) and
[paired comparison](REPEATABILITY-RESULTS.md) keep their original decisions. The
aggregation candidate improved list SQL and HTTP timing in the measured case,
but terminal-status p95 protection remained inconclusive. B remains unqualified
and C rejected. The evidence merge delivered no list production optimization;
full qualification and an implementation PR were not reached.

## Retired code and retained coverage

Decision records and JSON receipts move to `benchmarks/list-responsiveness/`,
following the billing decision archive. Repository layout requires a runnable
entrypoint in each `experiments/` directory; the completed record no longer needs
one. Historical reports, protocols and receipts retain their original bytes.
The terminology checker permits the archived TCP socket report's technical field
names only at its exact path and SHA-256; changed copies receive normal checks.

The A/B/C, aggregation and repeatability commands, their private launchers,
candidate rewrites and native observation build hooks are removed. The API
Performance workflow returns to its billing comparison: the temporary
`list-repeatability` and `list-status-control` choices and their three jobs are
removed. The billing runner, daily schedule, manual inputs, backend selection,
concurrency, reporting and failure notification remain in place.

Read-only diagnostic analysis moves into `test/helpers/list-responsiveness/`
without its command-line wrappers. The retained tests cover complete offered-work
accounting, delayed successes, cancellation, drainage, caught isolation violations,
request/server correlation, missing observations, paired-block estimators and
thresholds, fixture identity/storage, and missing or corrupt artifacts. Frozen
policies and evidence readers remain available to verify archived studies.
Tests that only exercised retired candidate rewrites, native build hooks or the
old command's extension/screening behavior retire with those implementations.
Production list, ownership, projection and container-spec regressions remain.

## Evidence preservation

All available historical workspace evidence, including failed attempts, raw
traces, complete responses, original archives, source snapshots and the original
request, is retained outside the disposable workspace at:

```text
~/anycloud-evidence/list-responsiveness/20260917T164151Z/
```

The archive contains 98 individually inventoried gzip tar files covering 81,427
regular files and 24,648,526,332 source bytes; compressed archives total
6,132,760,493 bytes. Each regular file was hashed during capture and checked again
by decoding the archive. Paths, sizes and SHA-256 hashes are recorded per archive;
the top-level `inventory.json` has SHA-256:

```text
ab169b88a3edacd3345cc26619545751b466fc1d6ab1a3342e442d47c3ffaae2
```

Installed `node_modules`, Git checkout metadata, Finder metadata and the active
closeout directory are excluded from that historical snapshot. Symlinks are
recorded without following external targets. The archive is a verified local copy
outside Conductor, not a remote backup. The latest GitHub artifacts expire
September 24, 2026; their original hashes and identifiers remain in the
[status-control receipt](status-control-receipt.json). Original workspace evidence
has not been deleted.

Historical commands in these documents require the exact measured revisions,
dependencies and runtime recorded by each study. The complete retired source is
available in the reviewed tree
and original evidence archives. Moving a reader does not reattribute a measurement
to the current checkout or change its frozen policy.

## Completion

Cleanup needs its own reviewed PR and repository verification, including the
unchanged six-second integration gate. Its merge completes the parent's remaining
executable-removal item. Both billing PRs
are already merged;
the published v0.1.64 release predates the later one and this list closeout. Merge and
release remain separate states. No release, deployment or new performance study
is part of this cleanup.

Any future list optimization is a separate task requiring a new, testable
hypothesis and justified qualification protocol. The retained results do not
authorize additional samples, relaxed thresholds or promotion.
