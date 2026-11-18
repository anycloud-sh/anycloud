# RFC 0004: Serve hardening

> Status: Proposed
> Date: 2026-06-16
> Author: Luis
> Updated: 2026-08-16 to distinguish shipped ingress work from open hardening;
> 2026-08-31 to record that the superseded issue trackers remain closed.

Supersedes three earlier, now-closed issue trackers.

Depends on [RFC 0003](./0003-serve-revival.md): `serve` must exist before the HTTP
ingress half can ship.

## Summary

Harden the security boundary around jobs and revived `serve` workloads before `serve`
becomes a supported public feature. This RFC consolidates three related gaps into one
plan: stop injecting broad GitHub OAuth tokens into workloads by default, make
`ipWhitelist` real for VM SSH ingress, and lock server HTTP ingress behind the Cloudflare
front door with TLS and workload-scoped networking.

## Current implementation status

This RFC remains proposed because only one of its three product outcomes is
complete on main:

- **Shipped — Cloudflare-only HTTP origin ingress.** An earlier change restricted managed
  Service HTTP ingress to Cloudflare source ranges. The current shared ingress
  specification and provider networking paths enforce that boundary.
- **Partially hardened, proposal still open — workload GitHub tokens.** Runtime
  secrets are delivered through a root-only env file instead of being embedded
  in the Docker command, but the authenticated user's broad OAuth token is still
  stored with the workload and injected automatically as `GITHUB_TOKEN`.
  Default-off delivery and short-lived, repository-scoped GitHub App tokens have
  not shipped.
- **Not exposed end to end — SSH `ipWhitelist`.** Shared networking and provider
  gateways can consume source CIDRs, but normal workload orchestration passes
  an empty list and there is no supported CLI/SDK request surface. SSH therefore
  retains the open-to-all source range (`0.0.0.0/0`) by default.

The superseded trackers were closed when this RFC consolidated them; that closure did
not mark all three implementation slices complete. The two remaining outcomes
are recorded here but currently have no active implementation issue. File new,
scoped delivery issues before resuming either slice rather than reopening the
superseded trackers.

## Context / problem

The v0 `serve` revival in RFC 0003 intentionally restores the old prototype shape:
single-VM public HTTP, Docker restart policy, and a stable `anycloud.sh` endpoint. That
is useful for dogfooding, but not enough for supported customer use.

Three hardening problems should be tracked together because they overlap at the same
trust boundary:

- Today the user login token can be injected into workload containers as `GITHUB_TOKEN`.
  It is broad enough to read and write repos/packages the user can access. This is live
  for jobs already; long-running public servers amplify the exposure window.
- `ipWhitelist` exists as user-facing intent but is not enforced by AWS, GCP, or Azure
  SSH firewall rules. VM SSH ingress is effectively open to `0.0.0.0/0` with key auth.
- The old server ingress model opened public HTTP on the origin VM. Even with a
  Cloudflare Worker or DNS front door, direct-to-origin traffic could bypass the edge.

Public `serve` needs these resolved enough that the product has a coherent story for
secrets, SSH, and HTTP origin access. DNS Worker safety is a revival prerequisite owned by
[RFC 0003](./0003-serve-revival.md), not deferred hardening.

## Proposal

### 1. Default-off workload GitHub token injection

Stop passing the user's broad OAuth token into workload containers by default.

User-facing behavior:

- jobs and servers do not receive `GITHUB_TOKEN` unless the user explicitly opts in to
  runtime repository access;
- images that only need GHCR pull access keep working because host-side Docker login is
  separate from in-container runtime credentials;
- when runtime repo access is enabled, the environment variable remains `GITHUB_TOKEN`
  so existing entrypoints do not need to change.

Implementation shape:

- add an explicit CLI/SDK option for runtime GitHub access;
- mint a short-lived GitHub App installation token scoped to selected repos and
  `contents:read`;
- expire tokens on the GitHub App's natural lifetime and avoid storing plaintext runtime
  tokens beyond workload start;
- preserve host-side GHCR auth separately from workload env injection.

### 2. Real `ipWhitelist` for SSH ingress

Make `ipWhitelist` enforce source CIDRs for job VM SSH ingress on AWS, GCP, and Azure.

User-facing behavior:

- when `ipWhitelist` is provided, SSH ingress is limited to those CIDRs;
- when it is omitted, v1 keeps today's open default for compatibility unless a separate
  decision changes the default;
- `exec`, `logs`, and monitor SSH behavior must still work from the control plane host.

Implementation shape:

- preserve the request field and thread it through route validation, conduct, provisioner,
  and gateway firewall creation;
- update AWS security group rules, GCP firewall rules, and Azure NSG rules to use the
  requested CIDRs instead of hardcoded `0.0.0.0/0`;
- handle existing workloads conservatively: do not rewrite firewall rules until a
  workload is created or explicitly reconfigured;
- keep Cloudflared/no-public-SSH as a future alternative, not a prerequisite for this RFC.

### 3. Cloudflare-only HTTP origin ingress for `serve`

Do not expose server origins directly to the public internet.

User-facing behavior:

- public server URLs terminate at `https://<workload-id>.anycloud.sh`;
- origin VMs accept HTTP/HTTPS traffic only from Cloudflare's published IP ranges;
- private/internal serve can use `ipWhitelist` to restrict access to caller-provided CIDRs;
- HTTP should redirect to HTTPS or be used only for edge-origin validation, not as the
  public user-facing scheme.

Implementation shape:

- fetch or vendor Cloudflare IPv4/IPv6 ranges and apply them to origin firewall rules;
- create per-workload AWS HTTP-origin security groups from the requested network
  intent instead of putting HTTP ingress on the shared VM security group;
- keep GCP/Azure per-workload firewall/NSG objects and apply the same source-range
  policy;
- serve TLS on 443 through the anycloud front door and make origin bypass ineffective;
- keep DNS Worker/source management in the `serve` lifecycle path from RFC 0003.

## Alternatives considered

### Keep separate GitHub issues

The issues describe the symptoms well, but they split one security posture across token,
SSH, and HTTP surfaces. Consolidating into an RFC keeps the product/security decision in
one durable place while individual implementation tasks can still be split later.

### Remove all in-container GitHub tokens

This would be safest but breaks legitimate runtime `git clone` use cases. The proposed
shape keeps the compatibility surface while shrinking blast radius through opt-in,
read-only, short-lived GitHub App tokens.

### Use Cloudflared before enforcing `ipWhitelist`

Cloudflared may be the better long-term SSH story, but it is a larger control-plane
change. Real `ipWhitelist` is still valuable now and is directly reusable for private
serve ingress.

### Leave origins public and rely on app auth

This does not protect users running untrusted or accidentally unauthenticated services.
The infrastructure should prevent direct origin bypass regardless of the app's own auth.

## Risks & caveats

- Changing the token default can break images that silently depend on `GITHUB_TOKEN`.
  The rollout needs clear CLI/SDK affordances and error messaging.
- Cloudflare IP ranges change. The implementation needs a reliable update path or a
  deliberately vendored range file with an owner for refreshes.
- Keeping open SSH as the omitted-`ipWhitelist` default preserves compatibility but is
  not the final desired security posture.
- Per-workload AWS HTTP-origin security groups increase resource count and cleanup
  burden.
- This RFC hardens `serve`; it does not add the programmatic node-pool workflow from
  [RFC 0005](./0005-programmatic-serve-nodes.md), and it does not add anycloud-owned
  routing, session affinity, drain, or autoscaling semantics.

## Open questions

- Should omitted `ipWhitelist` remain open by default, or should new workloads default
  to the control-plane egress IP plus the user's current IP?
- Should Cloudflare IP ranges be fetched at runtime, bundled at release time, or managed
  through a small operator script?
- How should users select GitHub App repositories for runtime clone access in the CLI and
  Python SDK?
- Should private/internal serve bypass Cloudflare entirely or still use the same front
  door with access controls?

## Decision

Pending. Cloudflare-only HTTP origin ingress shipped independently, but the RFC
as a whole is not accepted or complete while token down-scoping and a supported
SSH allowlist path remain open.
