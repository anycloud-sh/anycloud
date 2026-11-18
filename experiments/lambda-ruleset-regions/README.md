# Lambda ruleset regions

- Status: Complete — only us-south-1 rejects rulesets
- Decision record: which Lambda regions can run node pool VMs behind a per-instance firewall
  ruleset (RFC 0033)
- Run: `npx tsx experiments/lambda-ruleset-regions/run.ts` through the
  [Spike workflow](../../.github/workflows/spike.yml) with `arguments` `[]`
  and `cleanup_arguments` `["cleanup"]`

Lambda node pool VMs block inbound traffic, including the kubelet's TCP 10250,
with an empty firewall ruleset attached at launch. Some regions reject
rulesets. For every region in the Lambda catalog (the regions
`LambdaCatalogFetcher` publishes), `run` creates one empty ruleset named
`anycloud-spike-ruleset-<run>-<region>`, records success or Lambda's exact
error, and deletes it. Lambda rulesets carry no tags, so the name prefix is the
ownership marker. Nothing else is created.

`cleanup` lists rulesets with the `anycloud-spike-ruleset-` prefix, deletes
them, and fails unless none remain. Re-dispatch it with `arguments`
`["cleanup"]` if a run was interrupted.

`lambda-ruleset-run.json` holds each region's outcome, the supported and
unsupported region lists, the catalog capacity (instance type × region rows,
instance types and GPU types) in unsupported regions and in no supported
region, and each instance type's architecture. `lambda-ruleset-cleanup.json`
lists what cleanup deleted and what remains.

## Result

Run 37831607151
(2026-10-08) probed the 18 catalog regions. 17 accepted an empty ruleset.
`us-south-1` rejected it with `HTTP 400 [global/invalid-parameters] Firewall
rulesets are not supported in the us-south-1 region.` Cleanup found nothing
left.

`us-south-1` holds 23 of the catalog's 362 instance type × region rows,
covering 23 of 24 instance types and the A10, A100, A100-80GB, A6000, B200,
H100, RTX6000 and V100 GPUs. Every one of those types is also offered in a
region with rulesets, so refusing `us-south-1` removes no instance type or GPU.
`gpu_1x_gh200` is the only arm64 type.

## Promotion criteria

None: the result becomes the region list in `src/shared/catalog/lambda.ts`
that node pool admission checks.

## Deletion criteria

Delete this directory when Lambda node pools ship, or sooner if Lambda
documents per-region ruleset support.
