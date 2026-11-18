# Repository scripts

This directory owns supported entrypoints for developer workflows, releases,
repository policy, catalog maintenance, and recurring operator diagnostics.
Workflow helpers that exist only for CI belong in `ci/`, or in `scripts/ci/`
when they operate a supported lifecycle a human also drives locally — the local
SmolVM runner, and folding pending changelog entries into a release section.

Do not put shipped behavior, test assertions or test helpers, temporary proofs,
or performance probes here. Those belong in `src/`, `test/`, `experiments/`,
and `benchmarks/`, respectively. Every experiment needs a lifecycle README and
must be promoted or deleted when its decision is complete.
