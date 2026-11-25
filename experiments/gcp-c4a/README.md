# GCP C4A in europe-west4

- Status: Running.
- Decision record: should anycloud and backmesh run Jobs on GCP C4A (Axion,
  arm64) in europe-west4 for a design partner's Rust CI? It measures C4A's
  spot capacity per zone, its launch-to-container time and a ripgrep release
  build's time and cost, against C4D and N2 in the same region.
- Run: `experiments/gcp-c4a/run.ts` through the
  [Spike workflow](../../.github/workflows/spike.yml), with
  `cleanup_arguments` `["cleanup"]`. `arguments` `["preflight"]` records
  quotas, machine types, images and prices and creates nothing. `["run"]`
  runs the builds: `--rounds=<n>` (default 10), `--first-round=<n>` and
  `--max-vcpus=<n>` (running vCPUs at once, default 32). `["spot"]` runs the
  spot probe. `report <results.json...>` rewrites the build report without a
  cloud.
