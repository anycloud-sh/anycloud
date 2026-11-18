# Azure resource disk redeploy

- Status: Passed; the store unit now waits for Ubuntu's disk warning, which
  made the Docker store immutable on the second boot.
- Decision record: following the image-pull attribution spike's first result.
  It answers whether the VM host's Docker and containerd stores land on the
  resource disk of the GPU image VM Jobs boot, and whether a deallocation,
  which hands the VM a fresh resource disk, re-creates them before the daemons
  start. The coordinator chose this check on 2026-10-23, for about $0.30.
- Run: `experiments/azure-resource-disk-redeploy/run.ts` through the
  [Spike workflow](../../.github/workflows/spike.yml) with `arguments` `[]` and
  `cleanup_arguments` `["cleanup"]`. `render` prints the guest script.

`run` creates one resource group in `westus2` holding one on-demand
`Standard_NC4as_T4_v3` (180 GB resource disk). It boots the dstack CUDA image
`azure.ts` gives a T4 VM Job, with e2e-gpu's MACE OS disk: 100 GB of
Premium_LRS. The customData runs the product's `RESOURCE_DISK_PROBE` and
`resourceDiskStoreInstallCommand` as `initializeVM` does. It then starts Docker,
writes a marker into `/var/lib/docker`, and reports to the serial console.
`run` reads that report from boot diagnostics, then deallocates and starts the
VM. A timer installed on the first boot reports again a minute into the second,
outside the boot transaction, so the report cannot hold boot up.

The run passes when all of these hold:

- the probe names a mount;
- both stores are bind mounts from the resource disk on both boots;
- on both boots the store unit went active before Docker, and containerd
  when it ran, began starting;
- the marker is gone on the second boot, so the disk was fresh;
- on the second boot, `ephemeral-disk-warning.service` went active before the
  store unit, and its warning file is on `/mnt`, which stays mutable;
- Docker's root is `/var/lib/docker` on the second boot;
- the journal shows no ordering cycle.

It writes `boot1.txt`, `boot2.txt` and `summary.json`. A boot that never
reports leaves its partial report, the serial log and the VM's instance view.
Each report lists systemd's queued jobs and the store unit's status, then
queues a Docker start and polls it for up to five minutes, so a stall shows
where it waits. When Docker does not start, the report adds Docker's status
and journal, containerd's journal, `daemon.json`, both store directories'
listings, the mode and attributes of the Docker store and `/mnt`, audit records
of `chmod` and attribute changes, and the journals of the boot's disk units.
Each report names the running kernel.

`cleanup` deletes every resource group tagged
`anycloud-spike=azure-resource-disk-redeploy` and fails unless none remain.

## Result

Run 40011346852
found both stores bound from the fresh resource disk on both boots, in order,
with the marker gone. Docker failed to start on the second boot, while
containerd started; that run did not capture why.

Run 40016079316
captured it: each `dockerd` start exited with
`chmod /var/lib/docker: operation not permitted`. The bound store was an empty
ext4 directory with mode `dr--r--r--`, although the store unit had created it
`0711` a minute earlier. A bind made from NTFS would report NTFS in `findmnt`,
so the resource disk was already ext4 when the unit bound it. Something changed
the directory after the unit ran.

Run 40020671351
named it. About 1.4 seconds after the store unit bound the stores, a root shell
ran `chmod 0444` and then `chattr +i` on
`/mnt /var/lib/docker /var/lib/containerd/DATALOSS_WARNING_README.txt`. That is
`/usr/sbin/ephemeral-disk-warning`, which Ubuntu's `walinuxagent` package runs
from `ephemeral-disk-warning.service` (`After=cloud-config.service`) when a
fresh disk lacks the warning file. It finds the disk's mount point with
`awk '$1==R {print $2}' /proc/mounts` and leaves the result unquoted. The two
binds share the disk's device, so the lookup returned three lines. Its
existence check, `[ ! -f "${warn_file}" ]`, then tests the joined path, which
never exists. On boot 1 the binds were made after the warning ran; on any later
boot the store unit bound first, so the script fires on a plain reboot too. The
store unit now orders itself after that unit, which covers every boot.

Run 40032578270
at `ea88736eb` passed: on boot 2 the warning unit went active before the store
unit, its file is on a mutable `/mnt`, and Docker runs on `/var/lib/docker`
bound from the fresh resource disk.

## Promotion criteria

None. The result decides the boot unit, and e2e-gpu's Azure MACE leg
measures the pull.

## Deletion criteria

Delete this directory once its result is recorded and the change
ships, or if the VM host stops using the resource disk.
