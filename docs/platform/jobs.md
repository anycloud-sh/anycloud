---
title: Jobs
description: Run finite container workloads, recover spot jobs, pass data through buckets, and operate workloads through their lifecycle.
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';
import WorkloadLifecycle from '@site/src/components/WorkloadLifecycle';

# Jobs

A Job is a finite container workload. Use one for training, batch inference,
evaluation, data processing, builds, and any other task that should exit when
its work is complete. On VM-backed providers, Anycloud provisions a VM, runs one
container, records the result, and tears the VM down.

Use a [Service](/platform/services) instead when the process should stay online
and receive HTTP traffic. Use a [VM](/platform/vms) when you need an
interactive shell and direct control of the provisioned host.

## Submit a job

<Tabs>
<TabItem value="cli" label="CLI">

```bash
anycloud job ghcr.io/acme/train:latest \
  --credentials my-aws \
  --gpu-type h100:8 \
  --spot \
  --gpus all \
  -- python train.py
```

</TabItem>
<TabItem value="python" label="Python">

```python
from anycloud import Client

with Client() as client:
    job = client.submit(
        "ghcr.io/acme/train:latest",
        gpu="h100:8",
        command=["python", "train.py"],
        credential_name="my-aws",
        cloud_config={"spot": True},
        docker_options={"gpus": "all"},
    )
    job.wait(timeout_seconds=3600)
```

</TabItem>
</Tabs>

The Python example waits up to one hour. A `WorkloadWaitTimeout` stops
waiting without terminating the Job; see [Wait and terminate](/reference/python-sdk#wait-and-terminate).

Choose hardware by GPU name when the accelerator matters, or by exact VM type
when the instance shape matters. See [GPUs & VM Types](/platform/gpus-vm-types)
for that decision and [`job` reference](/reference/cli/job) for every
option.

### Docker in a VM Job {#docker-in-a-vm-job}

`--host-docker` is the supported way for a Job on a VM to run containers. It
replaces `--privileged`, which can't be combined with it. The Job gets the
host's Docker socket, joined to its group, and the host's `/workspace` as its
working directory, mounted at the same path, so a container it starts can
bind-mount anything under `/workspace`; `/workspace` replaces the image's
working directory, so give the Job's command an absolute path or one under
`/workspace`. It also gets `--init` and
`host.docker.internal`. With `--require-nested-virtualization` it gets
`/dev/kvm` too, joined to its group, for microVMs and emulators; a host
without `/dev/kvm` fails the Job instead of running it without KVM.

```bash
anycloud job ghcr.io/acme/ci:latest --credentials aws --vm-type m7i.xlarge \
  --host-docker --require-nested-virtualization \
  --shm-size 2g --ulimit nofile=1048576:1048576 -- /ci/build-and-test.sh
```

The container itself stays unprivileged: no added capabilities, and Docker's
default seccomp and AppArmor profiles. The socket still makes it
root-equivalent on its VM, since it can start any container there, which can
read what the host holds for the Job, such as its Secrets and bucket
credentials. Each VM Job
has a VM of its own, so that VM is the trust boundary: nothing else runs on
it. Services refuse `--host-docker`; an
`anycloud vm` dev box has the host's Docker already.

Where anycloud installs the host's Docker, it is set up for this:

- Its networks use the VM's network MTU, such as 1460 on GCP, so large
  downloads don't stall.
- Its containers get an open-file limit of 1048576 unless they set their own.
- Docker Hub images come through Google's mirror, `mirror.gcr.io`, so pulls
  aren't rate-limited per VM; Docker falls back to Docker Hub for an image the
  mirror lacks.

On AWS, GCP and Azure, other machines can't reach a `--host-docker` Job's
published ports: the VM takes only SSH from its network, even from other VMs
in it, and on the VM's IPv4 network the host drops new connections from
outside to its containers. The
Job, host-networked containers and other containers on the host still reach
them, through `localhost`, `host.docker.internal` or a shared Docker network.
On GCP, every VM Job's VM refuses the network's other VMs beyond its own
rules, with or without `--host-docker`; a Service's or `anycloud vm` dev box's
VM keeps its network's internal traffic.

<span id="workload-workflows"></span>
<span id="ci-pipeline"></span>

## Package code in the image

Build the application and its dependencies into a published image before
submitting it:

```bash
anycloud job ghcr.io/acme/trainer:sha-4d82f7a --gpu-type h100:8
```

Anycloud resolves the image to a registry digest before pulling it, so a
mutable tag always resolves to the content available for that workload.
Tag images with a commit SHA or another immutable release identifier when
reproducibility matters. See [Container Images](/platform/container-images) for
build, cache, and registry guidance.

<span id="provisioning-concurrency"></span>
<span id="error-states"></span>
<span id="auto-retry"></span>
<span id="credential-recovery"></span>
<span id="quota-recovery"></span>

## Lifecycle

<WorkloadLifecycle kind="job" />

Infrastructure setup failures are retried up to 100 setup attempts. Failures
during image download, data sync, or container startup can reuse an existing
VM. When replacement is required, retries wait for the provider to confirm
release of the old VM; waiting for cleanup does not consume setup attempts.
Invalid configuration is not retried. A GPU Job whose log shows an unusable
GPU, such as no CUDA device or an NVLink fabric that hasn't initialized, retries
up to three times on a fresh VM. A local API can have 50
workloads in the setup pipeline at once; that cap does not limit the number
already running.

`--max-retries N` caps a Job's automatic retries after a disruption at N per
submission, and `--max-retries 0` allows none, for a program with side effects
that must not repeat or a client that owns its retries. A disruption is a Job's
VM that is reclaimed or lost, during setup or while the program runs. A GPU
rerun above doesn't count. The budgets above still apply, and a spent budget
still ends `retries-exhausted`. Once the limit is reached, the Job ends
`failed`, and both `endReason` and `lastAttemptEndReason` name what ended its
last attempt: `reclaimed` when its capacity was taken back, or `lost` when its
VM went away otherwise. A resubmit renews the limit.

A job publishes its terminal outcome as soon as it is known; `completedAt` is
that time, and `endReason` says why it ended. `status` shows it as
`End reason`, and `list --json` and `wait --json` carry it too. The values are
part of the API contract, and clients generated from it reject a value they
don't know, so a new value is a contract change.

| `endReason`         | Meaning                                                                                                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `exited`            | The program exited: `completed` with code 0, `errored` otherwise                                                                                                                                             |
| `cancelled`         | Terminated by a user                                                                                                                                                                                         |
| `reclaimed`         | Its capacity was taken back, by the cloud, and `--max-retries` allowed no further retry                                                                                                                      |
| `lost`              | Its outcome couldn't be observed, its host went away, or its final output upload failed                                                                                                                      |
| `timeout`           | Its attempt passed its deadline                                                                                                                                                                              |
| `retries-exhausted` | A retry budget ran out, including the GPU reruns above; `lastAttemptEndReason` is whatever ended the final attempt, such as `reclaimed`, `lost` or `timeout`, or null before the program ran or when unknown |
| `invalid`           | Its configuration can never run                                                                                                                                                                              |

`endReason` is null until the job ends and on a job that ended before the API recorded it, and a resubmit clears it. Resource teardown continues without adding another lifecycle event,
and `cleanedAt` stays null until teardown succeeds; resubmission is blocked in
between. When a teardown attempt fails, `status` names the reason as
`Cleanup pending: …` (`cleanupError` in JSON) until an attempt succeeds. Compute spend follows each VM's own lifetime — from when it is created
until its `endedAt` cutoff — independently of both workload timestamps.

Use `status` to see the current phase and its events, `logs --follow` to
stream output from submission onward, and `wait` to continue only after the Job
succeeds:

```bash
anycloud status <job-id> --verbose
anycloud logs <job-id> --follow
anycloud wait <job-id> && echo "training finished"
```

`wait` exits `0` when the Job completes and `1` when it fails, and prints one
line per state change, so scripts and agents never parse status output. See
[`anycloud wait`](/reference/cli/workloads#anycloud-wait). While a spot Job is
retrying, `status` and `wait` show the attempt, when the next attempt is due,
and whether capacity or quota is the cause.

## Data and artifacts

Attach object storage when the job needs datasets, durable results, or
recoverable state:

| Container path    | Access     | Behavior                                     |
| ----------------- | ---------- | -------------------------------------------- |
| `/mnt/input`      | Read-only  | Downloaded before the container starts       |
| `/mnt/output`     | Read-write | Uploaded about every 60 seconds and at exit  |
| `/mnt/checkpoint` | Read-write | Restored at startup; uploaded during the run |

See [Buckets](/platform/buckets) for configuration and sync behavior.
An explicit checkpoint bucket works on both on-demand and spot Jobs. Spot Jobs
without one keep the automatic workload-named checkpoint described below.

<span id="retaining-checkpoints-across-runs"></span>

## Spot recovery

Spot capacity costs less but may be reclaimed at any point. With `--spot`,
Anycloud detects preemption and first tries to restart the VM in place;
otherwise it cleans up the lost VM, provisions a replacement, restores
`/mnt/checkpoint`, and restarts the container.

A cloud can also stop an on-demand Job's VM, for example for host
maintenance. Once the host stops answering SSH and the cloud reports the VM
stopped, Anycloud recovers the Job the same way, within `--max-retries`.

```python
from pathlib import Path
import json

checkpoint = Path("/mnt/checkpoint/state.json")
start_epoch = json.loads(checkpoint.read_text())["epoch"] if checkpoint.exists() else 0

for epoch in range(start_epoch, 100):
    train_one_epoch(epoch)
    checkpoint.write_text(json.dumps({"epoch": epoch + 1}))
```

Checkpoint changes sync about every 60 seconds, so checkpoint often and make
startup idempotent. The automatic checkpoint bucket is deleted when a spot Job
finishes. To retain checkpoint state across separate Jobs, create a bucket and
pass it with `--checkpoint-bucket`.

`anycloud status` shows the checkpoint bucket, its mount, whether it is kept
after the Job, and what has reached the bucket so far:

```text
Checkpoint: 52 objects, 101.0 MB in the bucket, newest 40s ago
```

<span id="chaining-jobs"></span>

## Compose jobs

Sequence Jobs with ordinary Python. Wait for a preparation step to finish, then
use its output bucket as the training Job's input:

```python
from anycloud import Client

with Client() as client:
    prepared = client.submit(
        "ghcr.io/acme/prepare:latest",
        credential_name="my-aws",
        gpu="h100",
        cloud_config={"output_bucket": "prepared-training-data"},
    )
    prepared.wait()
    trained = client.submit(
        "ghcr.io/acme/train:latest",
        credential_name="my-aws",
        gpu="h100:8",
        cloud_config={"input_bucket": "prepared-training-data"},
    )
    trained.wait()
```

The preparation container writes to `/mnt/output`; training reads from
`/mnt/input`. Use separate buckets or application prefixes for concurrent runs.
A failed wait raises before the next submission. To run independent Jobs in
parallel, submit them before waiting and handle partial failures in your
application. The SDK has no `JobGroup`, `submit_many()`, or `get_or_submit()`
helper.

<span id="debugging-a-job"></span>

## Operate and debug

```bash
anycloud job list --status running
anycloud logs <job-id>
anycloud exec <job-id> "nvidia-smi"
anycloud terminate <job-id>
anycloud resubmit <job-id>
```

`exec` and live logs require the workload's container to still be running.
When an output bucket is attached, logs are also copied under
`.anycloud/logs/`, preserving them after teardown. Exact lifecycle and
operation syntax is in [Workload operations](/reference/cli/workloads).

<span id="session-scoping"></span>

## Agent-operated jobs

The CLI supports coding agents that run and monitor Jobs directly. Commands
that print tables also provide structured output, and non-interactive
workloads from Claude Code, Codex, Cursor, and Aider are tagged with the
detected agent and session.

```bash
anycloud job list --agent codex --json
anycloud job list --session <session-id> --only-ids
anycloud status <job-id> --json
anycloud cost --agent codex --json
```

When an agent invokes `list`, `job list`, or `cost`, results default to that
agent's own session. This is cooperative scoping for usability, not an access
boundary; an explicit `--session` or `--agent` can select another scope.

Codex submissions use the native `CODEX_THREAD_ID` when available. Older
Codex environments that expose only `CODEX_BIN_PATH` retain the
`codex-<parent-process-id>` fallback. After upgrading, new native-thread scopes
do not include earlier process-based sessions. Select that history explicitly:

```bash
anycloud job list --session codex-49152
anycloud cost --agent codex
```

Claude Code and Codex session titles appear in human-readable session output
when available. Codex titles come from `session_index.jsonl` under
`$CODEX_HOME`, which defaults to `~/.codex`. Titles are captured when work is
submitted; renaming a session affects subsequent submissions. Missing or
unreadable titles keep the usual session identifier display.

Use `anycloud docs` for the documentation index and `anycloud docs --all` for
the full Markdown corpus. Pair autonomous sessions with
[per-session Spend Controls](/platform/spend-controls#agent-session-scope).
