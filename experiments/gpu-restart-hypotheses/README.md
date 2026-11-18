# GPU after an in-place restart

- Status: B reproduced and A refuted on one T4; see [Runs](#runs).
- Decision record: after an Azure spot eviction of a `Standard_NC4as_T4_v3`, the product
  restarts the same VM and re-creates the Job's container. Customers then hit
  `CUDA-capable device(s) is/are busy or unavailable`,
  `no CUDA-capable device is detected` or
  `Failed to initialize NVML: Unknown Error` 4–8 minutes later.
  An E2E run
  40003303765
  did not reproduce it with a simulated eviction. The owner chose
  "Hypothesis tests on one T4, Restart loop" (2026-10-23).
- Run: `experiments/gpu-restart-hypotheses/run.ts` through the
  [Spike workflow](../../.github/workflows/spike.yml) with `arguments` `[]` and
  `cleanup_arguments` `["cleanup"]`. `["b"]` runs only test B, `["loop"]`
  skips tests A and B, and a number such as `["loop", "12"]` caps the cycles.

## What it runs

One `Standard_NC4as_T4_v3` spot VM with `evictionPolicy=Deallocate`, on the
dstack CUDA image that `selectAzureGpuImageId` picks for a T4, in the first of
westus2, eastus, southcentralus and westeurope with capacity. The product's
`generateStartupScript` authorizes root's SSH key, and the product's
`initializeVM` sets up Docker and the NVIDIA runtime. The container is the
MACE legs' image, started like a Job's (`--restart no --gpus all`), running
`probe.py`.

A probe records, in the container, the `/dev/nvidia*` nodes, `nvmlInit`,
`cuInit` and the device count, and `torch.cuda.mem_get_info()` and
`nvidia-smi -L` in fresh processes. On the host it records `ls -l /dev/nvidia*`
and `lsmod` before anything touches the GPU, then the container's start time,
device requests, its OCI spec's devices and hooks (whether `--gpus` went
through the toolkit's hook or CDI), and systemd `DeviceAllow`. Cgroup v2 has
no `devices.list` and the image has no `bpftool`, so `DeviceAllow` stands in for
the cgroup device list. It also records kernel NVRM and Xid lines with
timestamps, systemd reloads this boot, `nvidia-smi -q`, and
the resume check, copied
from `waitForUsableGpus` at `4c8f23541`: `nvidia-smi -L`, then a CUDA context
on each device, up to three tries 20 seconds apart. The container keeps
running `probe.py monitor`, which initializes torch once, like a Job, and
probes every 15 seconds.

- **B, revoked mid-run.** Start a container, run `systemctl daemon-reload` on
  the host, then probe again (`B1`). `B2` repeats it with the devices also
  passed as `--device`, NVIDIA's documented workaround. `host.json` records
  the cgroup version, Docker's cgroup driver and the toolkit's `config.toml`.
  `B3-product-unfixed` and `B3-product` run the container with
  `DockerManager.getCommand`'s exact `docker run` args, as a Job's
  `{ gpus: 'all' }` produces them, without and then with the fix's `--device`
  substitution, so the fix is proven red then green on the product's args.
  `B3-product-count` repeats `B3-product` with `{ gpus: '1' }`, which selects
  the GPU node through `nvidia-smi`'s minor numbers.
- **A, devices late at start.** `A0`: a boot unit starts the probe container
  as soon as Docker is up. `A1`: a reboot, then the product's resume order
  (SSH, the Docker ping, the container, the probe) with nothing touching the
  GPU first. The spike skips the product's image re-pull and storage sync,
  so its container starts sooner after boot: a tighter race than the
  product's. `A2`: `nvidia_uvm` unloaded and its nodes removed, then
  `/dev/nvidia0` and `/dev/nvidiactl` removed; each starts a container, then
  re-creates the nodes with `nvidia-modprobe` and probes the same container
  again. The toolkit's hook loads the modules and creates the nodes itself
  (`load-kmods = true` by default), so A2 runs once as configured and once with
  `load-kmods = false`.
- **Restart loop.** Until the step's time runs out (about 6–8 cycles after A
  and B, about 9–10 with `["loop"]`): deallocate, or simulate an eviction
  (falling back to a deallocation), wait for three stopped reads as the
  product does, start, then resume in the product's order and hold the
  container for a minute. Cycles alternate the stop kind, and every other
  pair runs the resume check after the Docker ping and before the container,
  as the product does. Each cycle records the apt, unattended-upgrades and
  `walinuxagent` journals and the timers, candidate reload triggers after the
  container starts. The product's own `daemon-reload` calls all run before the
  container. The last container is held for up to 10 minutes, since customers
  failed 4–8 minutes after the restart.

`summary.json` lists for each probe whether the GPU was usable, which of the
customer's errors appeared, and the resume check's result. `records.json` holds the
evidence.

`cleanup` deletes every resource group tagged
`anycloud-spike=gpu-restart-hypotheses` and fails unless none remain.
Re-dispatch with `arguments` `["cleanup"]` if a run was interrupted. Because
cleanup selects by tag, dispatches must not overlap.

Not covered: a real eviction, which can't be triggered, and other GPU sizes
and clouds. The customer reports are all Azure T4 and A100 spot VMs.

## Runs

- 40016511502
  (`f008203a9`, westus2): failed in setup. `initializeVM` passed, then SSH to
  the VM timed out about 2.5 minutes into the image pull, and the run recorded
  nothing that explains it. Since then, the pull reconnects up to twice and
  records the guest's boots. Any failure also saves the VM's instance view and
  serial log (`*-serial.txt`). Cleanup deleted the group.
- 40018174203
  (`4444bb4db`, westus2): setup, B, A and 10 restart cycles, then Azure
  deallocated the VM one minute after the tenth cycle's boot. The spike didn't
  ask for it, and the serial log shows no guest shutdown. Cleanup deleted the
  group.
  - **B reproduces three of the customer's strings.** The host is cgroup v2
    with Docker's systemd driver, the toolkit runs as its legacy prestart hook
    with `load-kmods = true`, and the scope's `DeviceAllow` is strict. After
    `systemctl daemon-reload`, a new process in the running container gets
    `Failed to initialize NVML: Unknown Error` from `nvidia-smi`,
    `no CUDA-capable device is detected` (100) from `cuInit`, and
    `No CUDA GPUs are available` from torch. `busy or unavailable` (46) didn't
    appear. The monitor, which opened the GPU before the reload, kept working,
    so the failure shows at a process's first CUDA open after the reload.
    Explicit `--device` nodes (B2) survived. The resume check passed while
    the container was broken.
  - **A is refuted.** Every `/dev/nvidia*` node exists about 12 seconds after
    boot, before Docker starts. A0 at uptime 13 s, A1 and all ten cycles (five
    deallocations, five simulated evictions) were healthy, and the resume check
    passed in each. With the nodes deliberately removed, the toolkit recreated
    them at container start, even with `load-kmods = false`.
  - **Trigger.** No product path reloads systemd after a Job's container
    starts; every one runs in `initializeVM` or the storage sync, before it.
    On every boot, `cloud-init` reloads about 13 seconds in, before the
    container. `walinuxagent` reloaded twice on the first boot only. An
    agent update or reconfiguration after a real eviction is an unverified
    candidate. No reload after a container start was seen in the one-minute
    holds.

## Promotion criteria

Nothing is promoted: the result decides whether this needs a host fix beyond
the resume check and the retry patterns. A fix that comes out of it carries
its own regression test.

## Deletion criteria

Delete this directory once this is resolved.
