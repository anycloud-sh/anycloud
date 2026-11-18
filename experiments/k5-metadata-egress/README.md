# K5 metadata egress on a pool Node

- Status: Complete on AWS, GCP, Azure CPU and Azure GPU
- Decision record: spike route A (owner, 2026-10-18): why K5's egress
  NetworkPolicy let a new Pod reach instance metadata on an Azure GPU node
  pool, and whether the fix's Node block closes it on every cloud. Owner
  approved about $1 per dispatch.
- Run: `experiments/k5-metadata-egress/run.ts` through the
  [Spike workflow](../../.github/workflows/spike.yml) with `arguments` `[]`
  and `cleanup_arguments` `["cleanup"]`. `["run", "<target>", ...]` runs only
  the named targets (`azure-gpu`, `azure-cpu`, `aws`, `gcp`).
  - **Run A:** `source_sha` without the fix, such as `a227488e9`.
  - **Run B:** `source_sha` with the fix: any `main` commit with both the fix
    and this experiment.
    `summary.json` records which variant each Node ran.

`run` boots one VM per target on a pool VM's image: Azure
`Standard_NC4as_T4_v3` (dstack CUDA) and `Standard_D2s_v5` in westus2, AWS
`t3.medium` in us-east-1 and GCP `e2-standard-2` in us-central1-a, Ubuntu
24.04 otherwise. Each runs a local K3s server and the unchanged
`buildNodePoolAgentStartupScript`, applies the pool namespace and egress
policy, then runs three rounds of a `sleep 5` Pod followed by a probe Pod that
connects to `169.254.169.254:80` 60 times, 0.5 s apart, and on Azure to the
WireServer, `168.63.129.16:80` and `:32526`. The guest
records the Node's `filter` and `raw` rules every second. `summary.json` gives
per round the probe outcomes, `lastReachableSec` and `ruleSec` (seconds from
the first probe to the last reachable one, and to the Pod IP reaching the
filter rules) and the WireServer outcomes. A target without every round's 60
probes fails the run.

Not covered: the hosted API, pool Job buckets, the managed-Deployment
controller and GPU requests; an earlier train covers them. Lambda and
local have no metadata service at this address.

`cleanup` deletes every AWS instance, Azure resource group, GCP instance and
GCS bucket labelled `anycloud-spike=k5-metadata-egress` and fails unless none
remain. Every guest also shuts down 50 minutes after boot (AWS terminates
it). Re-dispatch with `arguments` `["cleanup"]` if a run was interrupted.

## Result

- **Run A, no block:** 39288642280
  (`47ce58751`) and, on Azure GPU,
  39332195913
  (`6946c314a`). A new Pod reached metadata on every target until its IP
  reached the filter rules, 0.55–2.6 s after the first probe.
- **Run B, with the fix:** 39288667462
  (`1b003786d`) and, on Azure GPU,
  39335849100
  (`e6b799a10`). No probe connected on any target or round.
- **WireServer:** reachable from every Azure Pod in both runs.

## Promotion criteria

None: the result decides the fix's Node block and is recorded in the decision
record above. The K5 probe in e2e-cluster-cloud stays the standing check.

## Deletion criteria

Delete this directory once that decision is recorded, or if the pool join
script stops being where the Node block lives.
