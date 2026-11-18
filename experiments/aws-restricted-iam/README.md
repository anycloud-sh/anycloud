# AWS restricted-IAM experiment

- Status: Complete — pilot items 1, 2 and 5 reproduced on 0.1.66
- Decision record: [RFC 0047](../../rfcs/0047-credential-scope-and-least-privilege-provisioning.md)
- Run: `gh workflow run spike.yml --ref main -f experiment=aws-restricted-iam -f source_sha=<sha> -f arguments='["0.1.66"]' -f cleanup_arguments='[]'`

## Hypotheses

1. Every managed AWS Job fails as `bad-credential` because the gateway calls
   IAM to create or read the shared `anycloud-vm-role` and
   `anycloud-vm-profile` before it launches the VM, and the pilot user has no
   IAM permissions.
2. A Job without `--region` validates its credential in the cheapest catalog
   region, which can fall outside the regions the credential allows, so
   admission fails as "could not conclusively validate cloud credential".
3. A GPU Job hits the same IAM failure before any quota error.

## Result

Runs 37553357118
and 37554544488
used 0.1.66.

- Hypothesis 1 confirmed. `t3.small`, `c6i.xlarge` and `g4dn.xlarge` pinned to
  `us-east-1`, and `t3.small` with no region (which defaults to `us-east-1`),
  each ended `invalid` with `AccessDenied` / `bad-credential` after about two
  minutes. Adding only the control policy below made the same pinned
  `t3.small` Job complete.
- Hypothesis 2 confirmed. `c6i.xlarge` with no region was rejected at submit:
  `AWS could not conclusively validate cloud credential "pilot-aws": Invalid
AWS credentials for region ap-south-1: … not authorized to perform:
ec2:DescribeVpcs … Please retry.`
- Hypothesis 3 confirmed. The GPU Job failed on IAM before any quota error.
  The test account has G quota, so zero-quota behavior is untested.

Run 37554544488's cleanup left its IAM user because it treated a missing
inline policy as a failure;
sweep run 37554779120
deleted it. Cleanup now deletes the policies a user actually has.

## What it does

The run phase uses the workflow's AWS keys to create a temporary IAM user, named
for the workflow run and attempt, whose
only policy mirrors the pilot: `ec2:*` limited to `us-east-1`, `us-east-2` and
`us-west-2`, plus the Spot service-linked role. It checks that the key works in
`us-east-1` and is denied in `ap-south-1`. It then installs the released CLI
(`get.anycloud.sh --version`), starts its published local API image in test
mode, saves the restricted key as a credential and submits five `echo ok` Jobs:
`t3.small` and `c6i.xlarge` with no region, and `t3.small`, `c6i.xlarge` and `g4dn.xlarge`
pinned to `us-east-1`. A control case then adds an inline policy granting only
the IAM actions on `anycloud-vm-role` and `anycloud-vm-profile` (including
`iam:PassRole`) and resubmits the pinned `t3.small` Job; if it runs, the shared
instance-profile bootstrap is the cause and that grant is the missing minimum.

Evidence in the artifact: each case's submit, wait, status and history output,
the full API log, the IAM- and region-related log lines, and `report.json`.
Access keys and the account ID are redacted.

## Cleanup

`inventory.json` in the evidence directory records the user and Job IDs as
they are created. It holds no access-key ID: cleanup lists and deletes the
user's keys itself. The cleanup phase stops the local API, terminates any
instance tagged with a recorded Job ID in the three allowed regions and
`ap-south-1`, and deletes the user's access keys, both inline policies and the
user. It does not delete the account's shared `anycloud-*` role, profile or
security group. The control case does change them: its grant lets the released
API create or rewrite the CI account's `anycloud-vm-role`, its inline policy
and `anycloud-vm-profile`, and those stay after cleanup, as they would after
any AWS Job from that version. To resume after runner loss or a failed
cleanup, dispatch with `arguments=["sweep"]` and empty `cleanup_arguments`: it
terminates live instances in the same four regions whose `Name` or
`anycloud_deployment` tag is `riam-`, a case name and an eight-digit run
suffix (the experiment's workload IDs), deletes every `anycloud-spike-restricted-*` user tagged
`anycloud_spike=aws-restricted-iam` with its keys and inline policies, and
records the users in `sweep.json`. Every phase redacts the account ID before
it logs, or every 12-digit number if the account lookup fails, and cleanup
continues either way. Cleanup failures are written to `cleanup-failures.log`.

## Promotion criteria

None directly. The experiment records evidence and asserts nothing. It
reproduces RFC 0047's scenarios S1 and S2 live against a released binary
until they become specs under `test/` with row A3. Its Jobs use
no bucket, so S3 and S7 are covered only by the specs row A4 adds.

## Deletion criteria

Delete this experiment once those specs land and pass on a release.
