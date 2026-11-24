# One T4 on a GCP N1 machine

- Status: Passed in
  [Spike run 45332827691](https://github.com/anycloud-sh/anycloud/actions/runs/45332827691)
  at `9b31dd4` (2026-11-24): the first spot attempt ran on `n1-standard-4-t4`
  in asia-southeast2-a and printed its `Tesla T4`.
- Decision record: [anycloud#9](https://github.com/anycloud-sh/anycloud/issues/9).
  The catalog now publishes `n1-standard-4-t4` and `n1-highmem-4-t4`, each an
  N1 machine with one attached `nvidia-tesla-t4`. This run proves a T4 VM Job
  launches and sees its GPU. Budget: $10. A T4 Job's VM costs about $0.20 an
  hour on spot and $0.55 on demand; the run takes under an hour.
- Run: `experiments/gcp-t4/run.ts` through the
  [Spike workflow](../../.github/workflows/spike.yml) with `arguments` `[]` and
  `cleanup_arguments` `["cleanup"]`. `["run", "ondemand"]` skips the spot
  attempt.

## What it checks

The published catalog only gains the T4 rows after this branch merges, so the
run first generates the GCP catalog with the branch's fetcher and fails unless
both T4 types have on-demand and spot rows. `catalog.json` records their zone
counts and lowest prices. `serve-catalog.mjs`, preloaded into the branch's API
and CLI, answers the published GCP catalog's URL with that file.

It then runs `nvidia/cuda:12.4.1-base-ubuntu22.04` as a VM Job with
`--gpu-type t4 --gpus all`, running `nvidia-smi && nvidia-smi -L`. The spot
attempt goes first. If it doesn't finish within 25 minutes, for example because
the project has no T4 spot quota, the run terminates it and tries on demand.
An attempt passes when the Job exits 0, its log names a `Tesla T4`, and its VM
was one of the two T4 types. `<attempt>-status.txt` holds the Job's history,
including any quota refusal with its quota name and region.

## Cleanup

The API's database and inventory live in `$RUNNER_TEMP/gcp-t4`. `run`
terminates its Jobs, waits until the API has ended their VMs, then lists GCP
instances and disks labelled with the Jobs' IDs and fails if any remain.
`cleanup` does the same from the inventory. If the runner is lost with its
state, the Job IDs (`gcp-t4-<attempt>-<run>`) are in the run log: delete the
instances labelled `anycloud_deployment=<id>`.

## Promotion criteria

None. The unit tests cover the catalog rows and the launch request; this run
proves GCP accepts the request and the GPU reaches the container.

## Deletion criteria

Delete this directory once a green run is recorded on the pull request.
