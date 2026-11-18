# Lambda resource-network experiment

- Status: Complete — provider firewall path rejected
- Decision record: [RFC 0015](../../rfcs/0015-anycloud-managed-kubernetes-clusters.md)
- Run: `yarn spike:lambda-resource-network`

This live experiment determines whether Lambda On-Demand Cloud can implement
RFC 0015's provider-neutral resource-scoped private-peer network contract
without adding an overlay network.

It uses at most two live VMs at once and probes:

- a public raw-TCP port can be restricted to the caller's IPv4 address;
- two VMs attached to one mutable firewall ruleset can communicate over their
  private addresses on TCP 10250 and UDP 8472;
- a VM attached to another ruleset cannot communicate with that scope;
- updating a ruleset changes existing instances without relaunching them;
- whether a replacement VM can reuse and adopt the original ruleset, when the
  networking prerequisites pass; and
- instances, rulesets, and the temporary SSH key are removed on every exit.

## Result

The live Lambda On-Demand Cloud run rejected this adapter shape:

- public raw-TCP rules were enforced and updates propagated to running VMs;
- same-region VMs exchanged private TCP and UDP traffic when those ports were
  absent from their attached ruleset;
- Lambda rejected rules with private `/32` source networks with HTTP 400; and
- VMs attached to two independent rulesets exchanged private TCP and UDP
  traffic in both directions.

The run confirmed deletion of every tagged VM, both firewall rulesets, and the
temporary SSH key. Lambda can still host the public AnyCloud API/control-plane
endpoint, but its current On-Demand firewall API cannot provide RFC 0015's
independent private resource scopes. Lambda capacity therefore requires an
encrypted overlay-network design or a different provider networking product.

The experiment requires `LAMBDA_API_KEY`. Optional overrides are:

- `ANYCLOUD_LAMBDA_NETWORK_SPIKE_REGION`
- `ANYCLOUD_LAMBDA_NETWORK_SPIKE_VM_TYPE` (default `gpu_1x_a10`)
- `ANYCLOUD_LAMBDA_NETWORK_SPIKE_SOURCE_CIDR`

## Promotion criteria

Promote a Lambda `CloudResourceCompute` adapter only after the live experiment
proves private-address peer traffic, independent-scope isolation, deterministic
ruleset adoption, replacement, and complete cleanup.

## Deletion criteria

Delete this experiment after the accepted behavior is covered by a live Lambda
provider qualification test, or if the result shows that RFC 0015 requires an
overlay-network design instead.
