# RFCs

Design proposals and their retained outcomes. An RFC captures the idea,
alternatives, open questions, and final disposition—not how the built product
works.

## Terminology

Active and accepted RFCs use **Workload** for shared Job/Service/VM records and
**Kubernetes Deployment** for persistent applications that accept Jobs. Use
**Deployment** once the Kubernetes context is established. Technical explanations
distinguish the **Deployment record** from the **native Kubernetes Deployment
object**; native objects retain qualified code names such as
`KubernetesDeployment`. Jobs, Services, VMs, and Clusters need product prefixes
only when the surrounding context leaves a real ambiguity. See
[current terminology](../ARCHITECTURE.md#terminology).

Rejected and superseded proposals, dated decision entries, recorded output, and
migration identifiers retain their historical names. A terminology update does
not change an RFC's decision, acceptance criteria, or implementation status.

## Conventions

- Numbered: `rfcs/0001-short-slug.md`, `0002-…`.
- One number per document, claimed when its pull request opens: take the
  smallest number above every RFC on `main`, every open pull request's claim,
  and every draft known to be in flight. Colliding parallel drafts renumber
  before merge; gaps left by abandoned or renumbered drafts stay unused.
- Every RFC opens with a decision `Status:` line — `Proposed` · `Accepted` ·
  `Rejected` · `Superseded` (link the replacement RFC when one exists).
- The RFC's `Status` and `Decision` are the sole record of its outcome.
- When an agreed plan changes a draft RFC (scope, extensions, resolved open
  questions, terminology), amend its text in its own commit and list the
  amendments on the issue or PR before setting `Accepted`; never just flip the
  status.
- An RFC that adds or extends a substrate shows, before `Accepted`, the target
  customer's real workloads with evidence (job records, scripts, transcripts),
  maps each one onto the proposed spec, and names any it doesn't serve. Keep
  customer identifiers (names, hostnames, usernames, project codes, job IDs)
  out of the repository.
- Keep implementation progress and later drift in a separate outcome/current-state
  note. Do not encode implementation percentages in the decision status.
- An RFC that states invariants annotates every entry with the enforcement
  layer that holds it — see [RFC 0025](./0025-enforcement-ledgers.md) for the
  vocabulary and validation.
- Assess proposed mechanisms against concrete requirements, failure modes, and
  maintenance problems; remove or defer unnecessary additions. Document only
  material choices, following [CONTRIBUTING.md](../CONTRIBUTING.md#code-quality).
- Update architecture and product documentation as an accepted decision ships.
- Copy `TEMPLATE.md` to start. Keep it lightweight — no mandatory review gates; this
  is a home for thinking, not a process.
- **Internal** docs. These are not part of the published `docs/` site.
