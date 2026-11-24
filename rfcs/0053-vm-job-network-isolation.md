# RFC 0053: An anycloud-owned network for VM Jobs

> Status: Accepted
> Date: 2026-11-13
> Author: Claude draft, for Luis Fernando De Pombo

## Summary

A VM Job is root on its VM with open egress. On AWS and GCP that VM sits in
the customer's default network, so a Job can open connections to the
customer's other instances there whenever their rules admit internal traffic.
This RFC proposes that VM Jobs on AWS and GCP launch into a network that
anycloud creates and owns, one per account and region (B below). That is the
isolation Azure Jobs already have, and it is the default for every anycloud VM
Job, not only backmesh's. An opt-out comes later, when someone asks. backmesh runs its
runners as VM Jobs and needs this before it supports public repositories (owner
decision, 2026-11-13). The gap exists today for backmesh installs that run only private repositories, and for any
anycloud Job that runs code its owner doesn't fully trust.

Asked by the owner on 2026-11-13: "investigate what would make more sense for
us". Context: backmesh's public-repos design draft
([anycloud-sh/backmesh#332](https://github.com/anycloud-sh/backmesh/pull/332);
the design is kept privately), which names this as "the one network gap".
Code is cited at `origin/main` `364432ef5`, under `src/api/services/` unless
the path says otherwise. _(external)_ marks cloud behavior documented by the
provider and not re-verified here. _(inference)_ marks reasoning the code
doesn't show.

## Where VM Jobs land today

| Cloud | Network and subnet                                                                                                                                                                                                                                                                                                                          | Firewall                                                                                                                                                                                                                                                                                             | Egress                          |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| AWS   | The default VPC. `RunInstances` passes no `SubnetId`, so EC2 picks a default subnet (`gateways/aws.ts:1211-1222`). The SG is created in the VPC with `IsDefault` (`:3059-3084`). Without a default VPC, `RunInstances` fails with `VPCIdNotSpecified` plus a hint (`:1378-1379`) and the launch moves to the next candidate (`:3897-3900`). | The shared `anycloud-vm` SG: SSH from `0.0.0.0/0` (`:2904-2935`, `network.ts:35-51`). It is never deleted (`aws.ts:188-194`).                                                                                                                                                                        | AWS default: allow all.         |
| GCP   | The `default` network. The NIC names no network (`gateways/gcp.ts:1411-1420`), and neither do the firewall rules (`:2615-2660`). A project without `default` fails with a hint (`:1758-1769`).                                                                                                                                              | Job VMs carry the `anycloud-job-host` tag (set where `refusesNetworkPeers` is true, `:1435-1437`). A priority-1001 deny refuses all ingress beyond the Job's own rules, which beats `default-allow-internal` (`:144-155`, `:1697-1710`). Cluster scopes deny job-host sources at 900 (`:1711-1721`). | GCP default: allow all.         |
| Azure | A new `10.0.0.0/16` VNet per workload, with no peering (`gateways/azure.ts:3347-3385`).                                                                                                                                                                                                                                                     | A per-workload NSG.                                                                                                                                                                                                                                                                                  | Azure default, in its own VNet. |

`refusesNetworkPeers` is true exactly for VM Jobs
(`workload-workflows/vm-host-startup.ts:561-564`). So today anycloud already
stops other VMs from reaching a Job's VM, but nothing stops the Job's VM from
reaching other VMs. There is no per-workload or per-credential option for the
VM's network. The existing `--network` option is a Docker network name
(`src/shared/docker-options.ts:31,253-261`), which is why this RFC names its
option `vmNetwork`.

**anycloud needs no private path to a Job's VM.** The API connects over SSH to
the VM's public address (`host-runtime/host-startup.ts:69-75`, set from
`PublicIpAddress` at `gateways/aws.ts:1156-1162` and from `natIP` at
`gateways/gcp.ts:1535`). Pool Nodes reach the cluster through an outbound
tunnel, with no node-to-node path ([RFC 0033](./0033-peer-networkless-jobs-capacity.md)).
The private IP is stored but nothing connects to it
(`repositories/workload-lifecycle.ts:755`). A Job host fetches debs from the
cloud's Ubuntu mirror (`job-host.ts:87-117`, `src/shared/providers.ts:229,256,276`).
Those are public hostnames: `<region>.ec2.archive.ubuntu.com`,
`<region>.gce.archive.ubuntu.com` and `azure.archive.ubuntu.com`.

**What backmesh needs.** The listener runs on a cluster Node and dials only
GitHub and the anycloud API. It never dials a runner. A runner dials:

- GitHub;
- the public runner image registry;
- the cache bucket, through the cloud storage endpoint with scoped tokens;
- the Ubuntu mirror.

All of these are public. The anycloud API's SSH into the runner is the only
inbound path
([backmesh's public repositories page](https://backmesh.com/public-repos/)).
So neither option below changes how the control plane reaches runners.

## Options

| Option                                                                                                              | What it protects                                                                                                                                                     | What it breaks or leaves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Source LOC (est.)                                                                          | Risk                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Egress block** of private ranges for Job VMs                                                                   | Blocks private addresses in the default network and anything reached through it over private ranges: peered VPCs, Transit Gateway, VPN to on-prem.                   | A blocklist that fails open: internal ranges outside the list stay reachable. It breaks private endpoints with private DNS (S3, ECR or STS interface endpoints; GCP Private Service Connect), which shows up as failing pulls or cache writes. It keeps the default-network dependency. On AWS it needs a Job-only SG holding the complement of the ranges: 31 egress rules, or 38 with `100.64.0.0/10`, against a default limit of 60 _(external)_.                                                          | ~110 (AWS SG + egress rules ~70, GCP deny rule ~20, IAM ~20)                               | Medium. The failures are silent and depend on the customer's setup, and the protection is only as complete as the range list.            |
| **B. anycloud-owned network** per account and region for VM Jobs (recommended)                                      | Leaves no route to any customer address. It is complete by construction and fails closed. It also removes VM Jobs' dependency on a default VPC or `default` network. | The anycloud network can't reach internal services. Today that reach happens by accident and some Jobs may rely on it; they lose it until the opt-out ships. It adds resources and quota use: one of 5 VPCs and IGWs per AWS region _(external)_, and one GCP network. Accounts whose SCPs or org policies forbid creating VPCs or networks can't run VM Jobs there until that changes. It adds IAM grants, so role connections need a re-run. On AWS anycloud must choose the subnet, and so the AZ (below). | ~260 (AWS VPC, subnets and AZ fallback ~190; GCP network ~50; IAM, templates and seed ~20) | Medium. Most of it is on AWS: subnet and AZ choice, the VPC quota, and SCPs. Fixed-path code, and a missing grant or quota fails loudly. |
| **C. B plus a customer-named subnet** (GitHub's Azure private networking model, and RunsOn's "existing VPC" option) | Same as B. A team that needs internal services names a subnet in its own network instead of falling back to the whole default network.                               | Same as B. A subnet reference pins cloud, region, and on AWS the AZ, so candidate selection narrows to one place. anycloud creates an SG or firewall rules in a network it doesn't own.                                                                                                                                                                                                                                                                                                                       | B + ~120                                                                                   | Medium. More validation surface. No customer has asked for a non-default network yet.                                                    |
| Rejected: iptables or nftables on the VM; a NACL or extra subnet in the default VPC                                 | —                                                                                                                                                                    | The Job is root on the VM (`--host-docker`), so it can remove any rule enforced on the VM. A NACL or subnet in the customer's default VPC changes their network and its address space.                                                                                                                                                                                                                                                                                                                        | —                                                                                          | —                                                                                                                                        |

Under B, DNS and metadata don't change, because each cloud gives a new VPC or
network the same resolver and metadata service _(external)_.

## Proposal

- **Smallest useful release.** VM Jobs on AWS and GCP launch into an anycloud
  network. Azure is unchanged, since every workload already gets its own VNet.
  This holds for every VM Job, with no per-workload opt-out in this release.
  Out of scope:
  - VMs, Services and pool Nodes stay where they are;
  - Lambda and local Jobs are unchanged. A Lambda instance has a public
    address and no customer network beside it _(external)_;
  - GCP project-wide metadata, which a Job can still read;
  - the opt-out and customer-named subnets, which come later (below).
- **AWS.** One VPC per region, tagged `anycloud_managed=shared` and found by tag.
  It gets a fixed `10.1.0.0/16`, as RunsOn uses (overlap matters only for a
  later peering or C). It has one public `/20` per AZ, an internet gateway, and
  a `0.0.0.0/0` route in the main route table. The VM gets a public address
  through `NetworkInterfaces[0].AssociatePublicIpAddress`, so the subnet and
  SG move into the interface spec. AWS Jobs use the shared `anycloud-vm` SG
  (`gateways/aws.ts:808-809,2815-2819`). B adds a second `anycloud-vm` in the
  new VPC, and the SG memo key gains the VPC id (`:2914`). A VPC, subnet, IGW and route cost nothing, and with no NAT
  gateway there is no new hourly charge _(external)_. A non-default VPC needs
  an explicit `SubnetId`, and one subnet's AZ may not offer the instance type.
  The lazy-pull spike hit exactly that in `us-east-1e` (run 43316366877,
  commit `a644ea034` on `experiment/lazy-pull`). So launch tries the region's
  subnets in turn and moves on after an unsupported-type or capacity refusal.
  Each subnet attempt takes its own client token, derived from the VM id and
  the AZ, because the launch reuses the VM id as its idempotency token and
  treats a mismatch as a concurrent create (`:1363-1375`). The region keeps one
  candidate, so `launch-targets` doesn't change. Subnets cover the region's
  `zone-type=availability-zone` zones, so Local and Wavelength Zones are left
  out, and a zone added later gets its subnet when a launch finds it missing.
- **AWS creation race.** Every `compute()` call builds a new gateway
  (`cloud-config.ts:104`), so a per-gateway memo can't stop a matrix of Jobs
  from each creating a VPC against the quota of 5. Creation runs once per
  account and region in the API process, behind a module-level lock. The VPC
  is tagged complete only after its route exists. Launches use the oldest
  complete tagged VPC, and a creator resumes an incomplete one instead of
  making another. A duplicate left by a second API process is reported, not
  deleted.
- **Fails closed.** When the network can't be made, the Job fails with a hint
  naming the quota or grant. That covers a missing grant, the AWS VPC or GCP
  network quota, or an SCP or org policy. It never falls back to the default
  network. Until the opt-out exists, such an account can't run VM Jobs in that
  cloud until the quota or grant is fixed. That is the accepted limitation, and
  the first such report is the evidence that would justify the opt-out.
- **GCP.** One auto-mode network, `anycloud-jobs`, created on first use. Auto
  mode adds a subnet in every region, so there is no per-region work. The Job
  VM's NIC and its firewall rules name that network. Firewall names are global
  in the project, so the network's rules take a distinct prefix. A new network
  has no allow rules, which means implied deny-ingress and allow-egress, so
  only the SSH allow is needed. Jobs in the network reach each other only over
  SSH, as they would from the internet. New Jobs no longer land in `default`,
  so the job-host deny rules and the cluster scopes' job-host deny
  (`gateways/gcp.ts:1697-1721`) become redundant. The implementation stops
  creating them, and the rules already in projects stay as they are.
- **Grants.** The policies in `src/shared/cloud-policies/` gain these, and so
  do the seed and role-connection templates:
  - AWS: `ec2:CreateVpc`, `CreateSubnet`, `CreateInternetGateway`,
    `AttachInternetGateway`, `CreateRoute`, `DescribeRouteTables`,
    `DescribeSubnets`, `DescribeInternetGateways` and
    `DescribeAvailabilityZones` (`RunInstances` on `*` already covers the
    public-IP interface);
  - GCP: `compute.networks.create` and `compute.networks.get`. The firewall
    and instance grants already cover a non-default network.

  This is required operator action for existing role connections. Without the
  grants, the first VM Job launch fails with the existing permission-denied
  report.

- **Cleanup.** The network is a standing shared resource, like the
  `anycloud-vm` SG and the shared GCP rules, which are never deleted
  (`gateways/aws.ts:183-194`, `gateways/gcp.ts:2666`), and like them it is
  tagged `anycloud_managed=shared`, which the resource sweep skips
  (`gateways/aws.ts:2936-2937`). GCP teardown already finds a workload's rules
  by tag across the project (`gateways/gcp.ts:2664-2680`), whatever the
  network.
- **Upgrade.** Running Jobs stay in the default network until they end. A Job's
  retry reuses its VM (`workload-workflows/vm-host-startup.ts:500-538`). New
  Jobs go to the anycloud network on their first launch in a region. The
  control plane is unaffected:
  - the management VM stays in the default network (`src/cli/seed/aws-stack.json`,
    `src/cli/seed/gcp.ts:371`);
  - pool Nodes stay where they are;
  - the API reaches Job VMs by public IP, as today.
- **Rollout.** Before the release that ships this, the owner confirms with
  existing production customers that their AWS and GCP VM Jobs don't depend
  on the default VPC or network, and that they'll add the new grants: a
  role connection by re-running its setup, and a key-based credential (an
  AWS IAM user or a GCP service account, often scoped down by hand) by adding
  the actions listed under Grants to its policy or role. The changelog entry
  and the docs say both plainly and list those actions, and a denied launch
  names the missing action through the existing permission-denied report.
- **Side benefit.** An AWS region with no default VPC fails VM Jobs today
  (`gateways/aws.ts:1378-1379`; seen in production as "No default VPC for this
  user"), and so does a GCP project without `default`. Under this change VM
  Jobs work there, since they no longer use the default network.
- **Size.** Source estimated +260, tests estimated +240. One implementation
  PR, with live checks on AWS and GCP and an Azure regression check.

### Default, and the opt-out later

Isolation is the default for every VM Job. That matches GitHub-hosted runners:
they have no access to customer networks unless the customer opts into private
networking with its own Azure VNet. RunsOn also defaults to its own VPC.
backmesh needs no setting.

**Later, when someone asks:** a per-workload `vmNetwork` field (CLI
`--vm-network`), named that way because `--network` is already the Docker
network name (`src/shared/docker-options.ts:31,253-261`). It would take
`default` for the cloud's default network and could later take a
customer-named subnet (C). It is about +120 source lines: a workload column
and migration, the API schema, SDK, CLI flag and docs (`host_docker` took
migration 0167). On Azure, `default` would be a no-op. backmesh could then pass
it on private runner Jobs from an install setting, and never on the
public-repos runner group.

## Required invariants

1. A VM Job on AWS or GCP has no route to an address
   in any customer VPC or network: its VPC or network has no peering, VPN or
   transit attachment.
   _Enforcement: test — the `aws-host-docker` and `gcp-host-docker` e2e
   members require the listener's VM in `anycloud-jobs`
   (`contracts/dedicated-job.ts` `#hostDockerMember`); that the network has no
   peering rests on its construction._
2. Nothing anycloud runs connects to a Job's VM except over its public address.
   _Enforcement: review — RFC 0033 and the SSH host above; no mechanism._
3. A VM Job on AWS or GCP never launches in the default network: failing to
   create the network fails the Job.
   _Enforcement: test — "0053/I3" in `aws-jobs-network.spec.ts` and
   `gcp.spec.ts`._

## Acceptance scenarios

Each live check runs on AWS and GCP. The Azure check is a regression run only,
since Azure Jobs are already isolated. Each is one `experiments/`-style run of
a small VM Job beside a canary VM in the default network. The canary listens
on a TCP port that admits the default network's range.

| ID  | Scenario                                                       | Required result                                                                                                                                 | Coverage                                                                                    |
| --- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| S1  | A VM Job boots in the anycloud network.                        | user-data runs (metadata works), DNS resolves, the Ubuntu mirror serves, a public image pulls, and a bucket write with a scoped token succeeds. | test:0053/S1 — unit tests; the AWS and GCP e2e-job members run there                        |
| S2  | The Job connects to the canary's private address.              | It fails. Connecting to the canary's public address follows the canary's public rules.                                                          | review — no default-network canary; the host-docker prober checks a Jobs-network peer       |
| S3  | Azure: a VM Job runs.                                          | It runs in its own VNet, as before.                                                                                                             | review — the Azure e2e-job members run unchanged                                            |
| S4  | Eight Jobs start at once in a region with no anycloud network. | One VPC or network remains, and all eight Jobs run.                                                                                             | test:0053/S4 — unit tests, within one API process                                           |
| S5  | AWS: the first subnet's AZ doesn't offer the instance type.    | The launch succeeds in another AZ.                                                                                                              | test:0053/S5 — unit test                                                                    |
| S6  | A credential lacking the new grants.                           | The launch fails with the permission-denied report naming the missing action.                                                                   | review — the existing permission-denied report; the policy scans prove the published grants |

## Alternatives and answered questions

The owner decided 1 and 2 on 2026-11-13. The answers to 3 to 7 are this RFC's
recommendations, adopted with its acceptance.

1. **Isolation by default for every VM Job, or opt-in that backmesh sets?**
   Owner decision: the default for every VM Job.
2. **Ship an opt-out in the same release?** Owner decision: no. The network
   ships alone, and `vmNetwork` comes when someone asks (above). Jobs that
   reach internal services in the default network lose that reach, and the
   changelog says so.
3. **Ship C (customer-named subnet) now?** Recommendation, adopted: no, not
   until a customer asks.
4. **Extend to pool Nodes, VMs and Services?** Pool Jobs share the same gap.
   Their egress policy excludes only the cluster's CIDRs and metadata
   (`kubernetes/node-pool-namespace.ts:81-130`), and the Nodes sit in the
   default network. Recommendation, adopted: a follow-up decision, not this
   release. VMs and Services are trusted by their owners.
5. **Uninstall.** Should the uninstall path delete the anycloud network?
   Recommendation, adopted: no. It stays standing, the same as the shared SG
   and rules today.
6. **A instead of B** if the AWS VPC quota or SCPs turn out common among
   customers. Recommendation, adopted: B now, with A only as a fallback. A needs no create grants, but it carries the private-endpoint
   breakage and the fail-open list above. It would also need live checks
   that DNS and metadata survive. AWS SGs don't filter the Amazon resolver or
   instance metadata, and GCP can't block its metadata server _(external)_.
7. **Unrelated to the network:** a GCP Job can still read project-wide metadata
   ([backmesh's public repositories page](https://backmesh.com/public-repos/)).
   Recommendation, adopted: out of scope here.

## Tracking

Implemented in [anycloud-sh/anycloud#20](https://github.com/anycloud-sh/anycloud/pull/20).

## Decision

Accepted by the owner on 2026-11-13 ("Default, no opt-out"), as amended in
`ce9ff598b`:

- Option B ships: VM Jobs on AWS and GCP launch into an anycloud-owned
  network. Isolation is the default for every VM Job, not only backmesh's.
- No opt-out ships in this release. The first report of a Job that needs the
  default network, or of an account that can't create the network, triggers
  `vmNetwork`.
- Rollout requires the owner's confirmation with existing production customers
  before release (Proposal, Rollout).
- Questions 3 to 7 take this RFC's recommendations.
