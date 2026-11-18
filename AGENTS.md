# Agent instructions

Keep this file small and durable. Use the repository documentation as the
source of truth:

- `CONTRIBUTING.md` for implementation quality, coding, testing, documentation,
  and user-facing writing
- `ARCHITECTURE.md` for system design, the data model, and security boundaries
- `RELEASE.md` for the release process
- `docs/` for shipped behavior

The maintainers keep anycloud's product records privately: product context and
the agent runtime's notes. Contributors don't need them: this repository's
documentation is complete for contributing.

Follow [Task context](CONTRIBUTING.md#task-context) for task briefs and preserving
the original request for review, [Issue triage](CONTRIBUTING.md#issue-triage)
before posting to issues, and
[Parallel agent work](CONTRIBUTING.md#parallel-agent-work) for worktrees and PR
body files.

For code reviews, read and follow
[Code review](CONTRIBUTING.md#code-review), including its linked Task context
and Code Quality guidance. It defines scope, evidence, simplification, and
required finding fields.

Follow the directory-ownership rules in `CONTRIBUTING.md`; in particular, do
not place shipped behavior, tests, experiments, or benchmarks in `scripts/`.
A "spike" or live reproduction is an `experiments/<name>/` run dispatched
through `spike.yml` by a maintainer, never a local API using local cloud
credentials.

Use **Workload** for shared Job/Service/VM records. Use **Kubernetes Deployment**
in mixed product contexts and **Deployment** once the Kubernetes context is clear.
Distinguish the **Deployment record** from the **native Kubernetes Deployment
object** in technical explanations; qualify native objects in code, for example
`KubernetesDeployment` and `kubernetesDeployment`. Avoid product prefixes on
Jobs, Services, VMs, and node pools unless needed to resolve ambiguity.
See the terminology in `ARCHITECTURE.md`.

Agents never pass the Release workflow's `hosted_gate_waiver` input and never
approve deployments; that break-glass is the repository owner's alone (`RELEASE.md`).

## Changelog

Add an entry as its own file under `changelog-unreleased/`, named for the
pull request and nothing else (`975.md`), only for shipped product changes
with material user impact: new or removed capabilities, meaningful behavior or
workflow changes, fixes for significant user-facing failures, security or
compatibility changes (breaking renames or removals), or required operator
action.

Changes confined to `website/`, `docs/`, or other documentation and marketing
content never receive a changelog entry. Neither do minor UX adjustments,
internal refactors, tests, dependency maintenance, or other changes that do not
materially affect product use. When uncertain, omit the entry unless users
would reasonably need the information when upgrading.

Each file holds one entry: a descriptive `###` heading and exactly one
paragraph. Aim for 25–40 words and never exceed 50. Focus on the user-visible
outcome and omit implementation details, test details, and exhaustive edge
cases. Preserve any commands users need. Name what changed or was removed and
its replacement; omit steps for upgrading from older versions unless a
maintainer asks for one ([Code Quality](CONTRIBUTING.md#code-quality)).

Never edit `docs/changelog.md` by hand — it holds released versions only, and
the release folds the pending files into a new version section.

## Verification

Run the narrowest relevant checks while iterating. Run `yarn verify` after
non-trivial code changes; for documentation-only changes, run Prettier on the
changed files and any relevant documentation or release checks.
