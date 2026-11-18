---
title: Run a coding agent in your own AWS account with anycloud
description: A walkthrough — give an autonomous coding agent its own VM inside your AWS account, with a read-only repo snapshot, checkpointed workspace, spot-preemption recovery, and auto-teardown. You can set it up in about five minutes.
slug: run-coding-agent-aws
tags: [agents, byoc, aws, spot, goose, claude-code]
draft: true
---

In February 2026, Meta's Director of Alignment watched her OpenClaw agent compact its context window, lose the "ask before acting" instruction, and delete 200 emails. She couldn't stop it from her phone.

<!-- truncate -->

Two months later, a Cursor agent driving Claude deleted PocketOS's production database _and its backups_ in 9 seconds. The agent's own confession: _"I guessed that deleting a staging volume via the API would be scoped to staging only. I didn't verify."_

When an autonomous agent holds your cloud credentials, the sandbox it runs in is beside
the point. A filesystem sandbox on someone else's computer doesn't contain a blast that
lands in _your_ AWS account.

This post shows you how to run a coding agent in a disposable VM inside your own AWS
account, with a checkpointed working directory and automatic spot-preemption recovery,
using [anycloud](https://anycloud.sh) and the public [Goose](https://github.com/block/goose)
agent image from Block. Setup takes about five minutes; the agent's run time depends on the task.

## What you'll have at the end

- A Goose agent running in a real EC2 VM you own, in a region you pick.
- Your repo mounted read-only in the VM, with the agent's patch exported to a synced output bucket.
- The VM terminates the moment the agent's task is done. You pay for the runtime, nothing else.
- If AWS reclaims the spot VM mid-task, anycloud provisions a replacement and resumes from the last checkpoint-synced state.

The blast radius is limited to one disposable VM. The agent can't reach your production stack because it never had credentials for that stack.

## Prerequisites

- An AWS account with EC2 + S3 permissions (anycloud uses standard IAM).
- An Anthropic API key. (Or OpenAI / a self-hosted model — Goose supports several providers.)
- A git repo you want the agent to work on.
- ~5 minutes.

## 1. Install anycloud

```bash
curl -fsSL https://get.anycloud.sh | sh
```

Open a new terminal, or run the command the installer prints, to put `anycloud` on your `PATH`. It runs locally — no SaaS account, no telemetry. The
orchestrator is a small Docker container managed by `anycloud api`. ([local API docs](/getting-started#start-the-api))

## 2. Wire up your AWS account

```bash
anycloud login
anycloud api start
anycloud credentials new aws        # paste an access key + secret
```

Credentials live in an encrypted SQLite DB on your machine
(`~/.anycloud/api.db`, libsodium-encrypted). They never leave your laptop.

## 3. Push your repo to a bucket

anycloud's bucket sync mounts input, checkpoint, and output buckets at fixed paths in
the container:

- `/mnt/input` is read-only and downloaded once at startup.
- `/mnt/checkpoint` is read-write and synced periodically for spot recovery.
- `/mnt/output` is read-write and uploaded periodically for final artifacts.

Create one input bucket for the repo snapshot:

```bash
aws s3 mb s3://my-repo-agent-bucket
aws s3 sync . s3://my-repo-agent-bucket --exclude 'node_modules/*'
```

## 4. Write the agent's task

Put a `task.md` at the root of your repo. The task tells Goose to copy the read-only
repo into the checkpoint mount before editing, then export a patch to the output mount:

```markdown
# task.md

The repo snapshot is read-only at /mnt/input.
If /mnt/checkpoint/workspace does not exist, copy the contents of /mnt/input into it.
Work only in /mnt/checkpoint/workspace.

Refactor src/sqs.ts to use long polling instead of the current short-poll loop.
Add a test in test/sqs.test.ts that exercises the new behavior.
Run `pnpm test` to confirm green.

When finished, run `git diff --binary` from /mnt/checkpoint/workspace and write it to /mnt/output/changes.patch.
Also write a short summary to /mnt/output/summary.md.
```

```bash
aws s3 cp task.md s3://my-repo-agent-bucket/task.md
```

## 5. Submit the agent

```bash
anycloud job ghcr.io/block/goose:1.9.0 \
  --credentials aws \
  --vm-type t3.large \
  --input-bucket my-repo-agent-bucket \
  --output-bucket my-repo-agent-output-bucket \
  --env-file goose.env \
  --spot \
  -- run -i /mnt/input/task.md \
       --with-builtin developer \
       --provider anthropic \
       --model claude-sonnet-4-6 \
       --no-session \
       --max-turns 50 \
       --quiet
```

Create `goose.env` with:

```
ANTHROPIC_API_KEY=sk-ant-...
GOOSE_PROVIDER=anthropic
GOOSE_MODEL=claude-sonnet-4-6
```

What's happening:

- `ghcr.io/block/goose:1.9.0` — the public Goose image, no auth needed.
- `--with-builtin developer` — enables Goose's bundled file-edit + shell-exec tools. Without this, the agent has no way to act.
- `--no-session` — Goose's one-shot mode. "Useful for automated runs" (per the docs).
- `--max-turns 50` and the implicit tool-repetition guards — address the well-documented "agent stuck in retry loop racks up a $47k bill" failure mode. anycloud also auto-terminates on container exit, so the worst case is bounded by the turn budget.
- `--spot` — anycloud provisions a spot VM. ~3–10× cheaper than on-demand. If AWS reclaims it mid-run, the deployment reconciler catches it and provisions a replacement; checkpoint sync brings the working state forward.

## 6. Watch it work

```bash
anycloud list                       # find the deployment ID
anycloud status <id> --verbose      # state machine, events + captured output
anycloud exec <id> "<command>"      # run a command on the VM (debug live)
```

State transitions you'll see: `provisioning` → `initializing` → `downloading` → `syncing`
→ `starting` → `running` → `completed`.

## 7. Pull the changes back

When the agent exits, the output bucket contains the patch and summary it exported:

```bash
mkdir -p agent-output
aws s3 sync s3://my-repo-agent-output-bucket agent-output
git apply agent-output/changes.patch
git diff
```

Inspect, commit if you like it, discard if you don't. The VM is already gone — anycloud
terminated it on container exit.

## Try this: kill the VM mid-run

While the agent is running, terminate the EC2 instance from the AWS console (simulate a
spot reclaim).

**Detection — within ~30 seconds:**

- anycloud's deployment reconciler flags the VM as preempted.
- The deployment transitions to `recovering`.

**Recovery — a few more minutes:**

- A replacement spot VM is provisioned (or the stopped VM is restarted, where the provider supports it).
- Checkpoint sync re-attaches the last synced working state to the new VM.
- The agent resumes from the last checkpoint that made it to the bucket.

No manual retry is required. Anything synced to the checkpoint bucket is preserved.

## What this is _not_ doing (yet)

- **Scoped IAM for the agent itself.** The agent in this walkthrough holds an Anthropic API key, not AWS credentials. If you want an agent that _can_ deploy to your AWS, give it a scoped IAM role with a spend cap on a sub-account — that's the v2 of this post.
- **MCP server wiring.** Goose supports MCP via `--with-extension`; out of scope here.
- **Git push-back.** The agent edits files; you commit them. A future variant can hand the agent a narrowly scoped GitHub token and let it open PRs directly.

## Why this matters

For agents that touch real cloud infrastructure — deploy code, provision resources, run
DevOps — a filesystem sandbox on a vendor's cloud doesn't actually contain the blast
radius. The damage lands in _your_ account regardless. The only containment that works
is running the agent _inside_ a separate, scoped, spend-capped account _you_ control —
which is exactly what BYOC compute is.

The same multi-cloud interface works across AWS, GCP, and Azure: change `--credentials`
and `--vm-type` to a GCP or Azure credential and VM type, and the rest is identical.

---

**Try it.** anycloud is in private beta — [request access](https://anycloud.sh).
Goose is open source (Apache-2.0): [block/goose](https://github.com/block/goose).
