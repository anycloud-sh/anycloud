# VM Job stop signal

- Status: Ready, not yet dispatched.
- Decision record: it asks whether `anycloud terminate` gives a running VM Job's process
  SIGTERM on every cloud. Azure's VM delete skips the guest shutdown that AWS
  and GCP perform, so the fix powers the Azure VM off gracefully first.
- Run: `experiments/vm-job-stop-signal/run.ts` through the
  [Spike workflow](../../.github/workflows/spike.yml), with `arguments` `[]`
  and `cleanup_arguments` `["cleanup"]`. `["run", "<target>", ...]` runs only
  the named targets (`azure`, `aws`, `gcp`).

## What it checks

The run builds the branch, starts its API and uses its CLI, the way a user
does. For each target it creates credentials, then starts a `python:3.12-slim`
VM Job:

| Target  | VM types, in order                                       | Regions                    |
| ------- | -------------------------------------------------------- | -------------------------- |
| `azure` | `Standard_D2s_v5`, `Standard_D2as_v5`, `Standard_D2s_v4` | eastus, eastus2, centralus |
| `aws`   | `t3.small`, `t3a.small`                                  | us-east-1, us-east-2       |
| `gcp`   | `e2-standard-2`, `n2-standard-2`                         | us-central1, us-east4      |

The fallbacks exist because eastus had no `Standard_D2s_v5` capacity in
run 42934468839.

The Job's process writes a `started` marker blob, then waits. On SIGTERM it
writes a `term` marker and exits. The markers go to an Azure container,
`anycloud-stop-signal-<run>`, through a container SAS passed in the Job's
environment, so they outlive the VM. Once a Job has started, the run calls
`anycloud terminate` and waits up to 5 minutes for its `term` marker.

The run passes when every target's `term` marker arrives. `summary.json`
records, per target, whether it arrived and how long after the terminate, or
the error that stopped that target; one target's failure doesn't hide the
others'. AWS and GCP are the controls: they already shut the guest down on
delete. Lambda is left out because its VM path is unchanged and its terminate API
documents no guest shutdown.

## Cleanup

The API's database, the inventory and the API log live in
`$RUNNER_TEMP/vm-job-stop-signal`. `run` waits until the API has cleaned up
every Job and ended its VMs, then deletes the marker container. `cleanup`
restarts the API from the same state, terminates the inventory's Jobs, waits
for the same cleanup, deletes the container, and fails if it remains. If the
runner is lost with its state, the run's Job IDs (`stop-signal-<target>-<run>`)
are in the run log: delete their VMs and the container by those names.

The API log is copied into the evidence with SAS signatures redacted.

## Promotion criteria

None. The unit tests in `test/unit/services/gateways/azure.spec.ts` cover the
power-off call and its bounds; this run proves the guest receives the signal.

## Deletion criteria

Delete this directory once a green run is recorded.
