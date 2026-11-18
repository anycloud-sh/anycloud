# Nested virtualization on every cloud

- Status: Written, not yet run. The coordinator dispatches it after review.
- Decision record: row B, RFC 0049 C10 (release 2, owner 2026-11-04): its live
  run checks
  `/dev/kvm` on each cloud. Budget: under $2 per cloud. The estimate
  is about $0.10 per cloud for two small VMs for up to 25 minutes. A VM left
  behind costs about $0.10 an hour until `cleanup` deletes it.
- Run: `experiments/nested-virtualization/run.ts` through the
  [Spike workflow](../../.github/workflows/spike.yml) with `arguments` `[]` and
  `cleanup_arguments` `["cleanup"]`. `["run", "<target>", ...]` runs only
  the named targets (`aws`, `aws-control`, `gcp`, `gcp-control`, `azure`).

`run` first checks that the shipped catalog code admits each nested target's
type: AWS `m7i.large` in us-east-1 from the published AWS catalog, GCP
`n2-standard-2` and Azure `Standard_D2s_v5` from the reviewed series lists.
It then boots Ubuntu 24.04 on five VMs in parallel, each nested target
launched the way a `--require-nested-virtualization` pool VM is launched. It
fails early if the AWS region has no default VPC or the GCP project has no
`default` network.

- **`aws`**: `m7i.large` in us-east-1 with
  `CpuOptions.NestedVirtualization=enabled`.
- **`aws-control`**: the same type and region without that setting.
- **`gcp`**: `n2-standard-2` in us-central1-a with
  `advancedMachineFeatures.enableNestedVirtualization`.
- **`gcp-control`**: the same type and zone without that setting.
- **`azure`**: `Standard_D2s_v5` in westus2. Azure has no launch setting.

Pool Nodes never run `modprobe` for KVM, so the guest records the boot's
state first: the CPU's `vmx`/`svm` flags, the loaded `kvm` modules, and
whether `/dev/kvm` opens read-write and creates a VM (`KVM_GET_API_VERSION`,
`KVM_CREATE_VM`). That is the verdict. It then runs `modprobe` and records
`/dev/kvm` again, which shows only whether the join script would need it.
`run` reads the console from EC2's console output, GCP's serial port and
Azure's boot diagnostics, and writes `<target>-console.txt`, `catalog.json`
and `summary.json`. It fails unless `/dev/kvm` is usable on every nested
target and absent on both controls.

This experiment doesn't cover the pool path: the join script and a privileged
pool Job using `/dev/kvm`. The release-2 live round on AWS, GCP and Azure
proves it.

`cleanup` terminates every AWS instance and deletes every GCP instance
labelled `anycloud-spike=nested-virtualization`, and the Azure resource group
`anycloud-spike-nested-virtualization`. It sweeps each cloud even when
another fails, reports every error, and fails unless none remain. Guests shut
down 40 minutes after boot. AWS then terminates the instance. A GCP instance
stops, but its disk is billed until deletion. An Azure VM stays allocated and
keeps billing until deletion. Re-dispatch with `arguments` `["cleanup"]` if a
run was interrupted.

## Promotion criteria

None: the result confirms C10's reviewed series lists and launch settings.

## Deletion criteria

Delete this directory once the result is recorded on the release-2 tracker,
or if C10's launch settings change.
