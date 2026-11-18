# DLAMI NVMe takeover

- Status: Complete: the takeover holds on the real DLAMI across a reboot
- Decision record: ST2b, review finding 2: whether the AWS
  GPU AMI claims the instance store before ST2b's per-boot NVMe unit, and
  whether the unit's takeover and boot ordering hold across a reboot. Owner
  approved one g4dn.xlarge for about 20 minutes (2026-10-14).
- Run: `experiments/dlami-nvme/run.ts` through the
  [Spike workflow](../../.github/workflows/spike.yml) with `arguments` `[]` and
  `cleanup_arguments` `["cleanup"]`

`run` launches one on-demand `g4dn.xlarge` in `us-east-1` on the newest
"Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 24.04)", the image pool
GPU VMs boot on AWS. Its one instance-store NVMe goes through the same DLAMI
setup as P4d and P5. The user data records the DLAMI's NVMe unit, its ordering
against cloud-init, the block devices, `/opt/dlami/nvme` and `/etc/fstab`. It
then installs ST2b's NVMe unit exactly as `buildNodePoolAgentStartupScript`
renders it, behind a stand-in `k3s-agent.service` that carries the real
agent's ordering lines, starts it as the join script does, and reboots once. On
the second boot a report unit records whether both units came up, any
"ordering cycle" in the journal, and the mounts, then powers off; the instance
terminates on shutdown. `run` reads the serial console until the report, and
writes `console.txt`, `summary.json`, `image.json` and `instance.json`.

`cleanup` terminates every instance tagged `anycloud-spike=dlami-nvme` in
`us-east-1` and fails unless none remain. Re-dispatch it with `arguments`
`["cleanup"]` if a run was interrupted.

## Result

Run 38622584290
(2026-10-14, AMI `20261006`): `dlami-nvme.service` claims the instance store
before user data, as an LVM volume (`vg.01/lv_ephemeral`, ext4) mounted at
`/opt/dlami/nvme`, with no fstab line. The takeover at `347a94c61` stopped md
arrays but not LVM, so `wipefs` failed busy on both boots; boot ordering held
and the agent waited on the unit. Cleanup confirmed no instance left.

Run 38624493869
(2026-10-14, the same AMI, at `a81997906`, which also deactivates LVM):
both units were active on both boots, and after the reboot `/var/lib/kubelet`
and containerd's directory were bind mounts of the `anycloud-scratch` ext4 on
the instance store (114 GB free). The NVMe names swapped between boots, and
the label found the filesystem anyway. Cleanup confirmed no instance left.

## Promotion criteria

None: the result decides the takeover in `node-pool-join.ts`, and EX4 proves
the multi-device path on a named NVMe size.

## Deletion criteria

Delete this directory once its result is recorded and the takeover
ships, or if ST2b changes how it claims local NVMe.
