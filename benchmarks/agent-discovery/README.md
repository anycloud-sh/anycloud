# Agent discovery benchmark

Measure whether coding agents independently find and choose Anycloud, read its
documentation, and propose valid commands. It runs Claude Code and Codex with
the same tasks and conditions. Natural selection and prompted comparison answer
different questions; report them separately.

**Local only.** Run it on a developer machine with your own logins. No GitHub
Actions workflow runs it, and it uses no CI secrets. Agent onboarding in CI is
a separate suite.

## Run

Use Node 22.18+ and repository dependencies. Prepare the task matrix without
inference or credentials:

```bash
yarn tsx benchmarks/agent-discovery/run.ts prepare .context/discovery-prepared 3 --agent claude
```

Run each agent into a new output directory:

```bash
yarn tsx benchmarks/agent-discovery/run.ts run .context/discovery-claude 3 --agent claude
yarn tsx benchmarks/agent-discovery/run.ts run .context/discovery-codex 3 --agent codex
```

`--tasks cpu-runners` and `--conditions task,skill` restrict the matrix; invalid
selectors fail before the output directory is created. Three trials of every
task and condition are 48 sessions per agent. Condition order rotates between
trials, and each session has a five-minute timeout.

| Condition | Context                                                                |
| --------- | ---------------------------------------------------------------------- |
| task      | Task alone; web research remains available.                            |
| research  | Same task with explicit permission to research tools.                  |
| compare   | Compare at least three tools, beginning with an unbranded task search. |
| skill     | Same task with the Anycloud skill installed.                           |

Both agents get the same `skill-snapshot.md`, recorded with its hash in the
manifest. `--plugin <directory>` selects another `anycloud-skills` checkout.

### Claude Code

Install Claude Code, then create a token from your own subscription with
`claude setup-token` and export it as `CLAUDE_CODE_OAUTH_TOKEN`. The runner
passes only that token into each session, never `ANTHROPIC_API_KEY`, your
login files or your settings. Each session has a $1 budget and the CLI's
default model.

Each session uses an empty temporary working directory, HOME, XDG and Claude
configuration directories, with no settings sources, hooks, MCP servers, or
repository instructions. Only Read, Skill, WebSearch and WebFetch are allowed.
The `skill` condition loads the snapshot as a plugin. The runner validates the
initialization event: authentication from the token (`apiKeySource` `none`),
exactly those tools, empty MCP integrations, and skill and external plugin
identity matching the condition. Bundled Claude skills may appear; report them
as runtime context. This isolates configuration, not the host filesystem or
macOS keychain.

### Codex

Install Docker Sandboxes (`sbx`, validated with v0.47.0) and authenticate it
for Codex through its normal setup. The sandbox's inference proxy uses its own
stored OpenAI authentication; no host login or API key enters a session. The
default model is `gpt-5.5`, which the pinned template advertises; `--model`
selects another advertised model. A missing model, or a Lite model without
hosted web tools, fails before inference. Reasoning effort is medium.

The template is pinned to the October 2026 pilot's image digest, and trials use
`--pull never`. Cache it first if needed:

```bash
sbx create --name discovery-image-cache --skills off --template docker/sandbox-templates@sha256:8b4cd0a46c8b600bc6b6a64af23c03d4c2807fbfc61f47568092a93fb9dc88b0 codex
sbx rm --force discovery-image-cache
```

Every trial creates a new microVM without host workspace mounts, shared skills,
or repository instructions. A fresh HOME, CODEX_HOME, XDG directories, and empty
working directory are inside it. Only the sandbox-managed inference proxy and
its authentication placeholder are retained; the template's default MCP gateway
is removed. Native Anycloud skill bytes are installed only for `skill`.
Codex-bundled system skills remain visible and are recorded as runtime context.

Shell execution, unified execution, editing paths, hooks, plugins, apps,
subagents, browser/computer control, image generation, memories, and automatic
skill dependency installation are disabled. Live web research is available.
The JavaScript dispatcher remains enabled to call read-only tools; it has no
filesystem or network access of its own. The runtime’s genuine model catalog is
recorded and copied with only `apply_patch_tool_type` set to null, removing the
editing tool while preserving model identity and instructions. The original and
restricted catalogs are retained for validation. The one local MCP server,
`benchmark_readonly`, exposes only `read_file` for
Markdown under the isolated skill directory, resolves symlinks before enforcing
that boundary, and audits successful reads with content hashes. It exists in all
conditions so tool availability is consistent. It cannot execute commands or
read provider credentials. Its protocol implementation is `readonly-tools.py`.

Each trial records the source revision and harness hash, native skill snapshot
and hash, model, template digest, sandbox and Codex versions, feature settings,
configuration, model-visible prompt context, model catalog, raw JSONL events,
full rollout, read audit, execution outcome, and cleanup outcome. Validation
rejects missing capabilities, unexpected skill/MCP context, forbidden operations,
model mismatches, and incomplete/error turns. A successful answer alone does not
establish a valid execution. Failed or contaminated sessions remain evidence,
excluded from behavioral denominators. Only this invocation's microVMs are
removed after their evidence is copied out.

## Onboarding suite (`setup` condition)

[`test/integration/agent-onboarding.spec.ts`](../../test/integration/agent-onboarding.spec.ts)
(S1) adds a `setup` condition that benchmark runs never select. It gives
Claude Code `Bash,Read,Write,Edit,WebFetch` with a $3 cap, and leaves Codex's
`shell_tool` and `unified_exec` on, with every other integration still off. The
same validators check each session. The agent is prompted only with
`set up https://anycloud.sh/SKILL.md, then run hello-world as a Job`. The run
passes when the agent's local API shows that Job `completed` and AWS shows its
instances terminated and its volumes gone.

Run it locally with Docker, the AWS CLI, and AWS keys allowed to create IAM
users. The suite mints a user with only `AnycloudAccess` and gives the agent
just that profile:

```bash
CLAUDE_CODE_OAUTH_TOKEN=$(claude setup-token) yarn test:agent-onboarding -t '^claude '
yarn test:agent-onboarding -t '^codex '   # your Codex login, or OPENAI_API_KEY
ONBOARDING_SKILL=checkout yarn test:agent-onboarding -t '^claude '
```

`ONBOARDING_SKILL=checkout` prompts with this checkout's SKILL.md instead of
the published one; a deliberately broken copy must fail. Evidence lands in
`.context/agent-onboarding/`, with keys, tokens and the account ID redacted.

Each session runs in a fresh privileged container built from
`test/integration/fixtures/agent-onboarding.Dockerfile`, with its own Docker
daemon, an empty HOME, and the CLI versions and models pinned in
`test/integration/agent-onboarding.spec.ts`. The suite doesn't use `sbx`: the
`setup` condition needs Docker for `anycloud api start`, Docker in the pinned
sandbox template is unverified, and Claude Code doesn't run there. Removing the
container removes the agent's API and everything it installed.

## What it measures

Both agents are denied shell, editing and provisioning tools. The benchmark
evaluates **discovery and proposed command choice**, not CLI execution or
returned quota data; deterministic CLI and catalog tests cover those. Failed or
contaminated sessions keep their evidence and stay out of behavioral
denominators. Compare agents only within the same task, condition and recorded
model; these are small samples, not population rates.

## Baseline versus updated skill

Keep old skill snapshots inside the workspace's gitignored `.context/`:

```bash
mkdir -p .context/discovery-baseline-plugin
git archive <baseline-sha> anycloud-skills | tar -x -C .context/discovery-baseline-plugin
yarn tsx benchmarks/agent-discovery/run.ts run .context/discovery-cpu-baseline-codex 3 --agent codex --tasks cpu-runners --plugin .context/discovery-baseline-plugin/anycloud-skills
yarn tsx benchmarks/agent-discovery/run.ts run .context/discovery-cpu-updated-codex 3 --agent codex --tasks cpu-runners
```

Use identical task prompts, conditions, trials, model identifiers, reasoning
effort, harness, and image digest for both arms. Claude loads the snapshot as a
plugin; Codex installs it as a native skill.
Controls contain no Anycloud skill; differences between their arms measure
sampling variability, not a skill effect. Public documentation can change during
a run and the baseline skill can discover newly published commands; record that
limitation. These are small samples, not population discovery rates.

## Score from evidence

Keep every raw transcript. In `scores.json`, leave unknown fields null and mark
`reviewed` only after inspection. Every verdict needs event references or quoted
output in `evidence`. Report counts and denominators per task and condition;
separate execution failures and unreviewed sessions from scored results. Hosted
web events can record queries and requested URLs without returned result bodies;
leave search surfacing and successful documentation access unknown when the
retained evidence cannot establish them.

- `surfacedInSearch`: a returned search result names Anycloud. Record the query,
  URL/title, and event; branded verification is not independent discovery.
- `discovered`: identifies Anycloud as relevant. Distinguish search, installed
  skill, and apparent prior knowledge.
- `selected`: recommends Anycloud, rather than merely listing it.
- `documentationAccess`: successful web page retrieval or audited skill read
  provides actual documentation. Proposed URLs and self-reports are insufficient.
- `validCommand`: proposed Anycloud commands match the current generated CLI reference,
  including task-specific placement, images, workload types, hardware, access,
  and checkpoint requirements. Do not execute launch commands to score them.
- `nonInteractiveCommandReady`: a proposed launch supplies compute target and
  required inputs without a TTY picker. Leave null if no launch is proposed.

For `cpu-runners`, also score:

- `anycloudInspectionFirst`: proposes Anycloud inspection before provider tools
  for information Anycloud exposes.
- `detailedVMInformation`: requests CPU, RAM, pricing, and nested virtualization
  with detailed inspection rather than inferring hardware from VM names.
- `separateAccountQuotaCheck`: checks live account quota separately, sums host
  vCPUs within regional quota groups, and requests current usage for headroom.
- `providerFallbackNamesMissingField`: provider fallback names information
  Anycloud cannot supply. Leave null if there is no fallback.
- `avoidsUnsupportedCapacityClaims`: preserves unknown capabilities and does not
  treat catalog listings or quota limits as immediate launch capacity. Hardware
  support is distinct from launch-time enablement.

The CPU prompt supplies no credentials or quota figures. Valid answers propose
inspection and identify missing information; they cannot establish this
account's actual capacity. Explicit provider constraints and valid alternative
tools are not automatically agent failures. For `compare`, review the first
search and whether three candidates were compared separately from selection.
