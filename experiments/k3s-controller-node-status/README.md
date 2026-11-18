# K3s controller identity on Node status

- Status: GCP and Azure passed in
  run 42083338215
  (`ec946ee`): every patch returned 200 without the policy and 403 with it,
  while flannel's annotation returned 200 and flannel restored its
  annotations. AWS refused the launch: its encoded user data is capped at
  25600 bytes. The AWS user data is now gzipped (about 8 KB encoded), and a
  failed launch ends that target at once. AWS rerun pending
  (`["run", "aws"]`).
- Decision record: owner, 2026-11-05: "File + fix in release 2". It checks two
  things: that a
  privileged pool Pod can use the shared `system:k3s-controller` certificate
  to rewrite another Node's labels and status, and that the `node-status`
  cluster add-on's admission policy blocks this while flannel still writes
  its annotations. It runs on AWS, GCP and Azure. One run costs about $0.10:
  one small VM per cloud for up to 40 minutes.
- Run: `experiments/k3s-controller-node-status/run.ts` through the
  [Spike workflow](../../.github/workflows/spike.yml) with `arguments` `[]`
  and `cleanup_arguments` `["cleanup"]`. `["run", "<target>", ...]` runs only
  the named targets (`aws`, `gcp`, `azure`). Use a `source_sha` that contains
  the fix: the policy comes from `buildNodeStatusPolicy` at that commit.

`run` boots one Ubuntu 24.04 VM per cloud, the same way
[k5-metadata-egress](../k5-metadata-egress/README.md) does: AWS `t3.medium`
in us-east-1, GCP `e2-standard-2` in us-central1-a and Azure
`Standard_D2s_v5` in westus2. Each VM runs a local K3s server at the system
release's pinned version, then joins its own agent with the unchanged
`buildNodePoolAgentStartupScript`. It labels the Node a member of its pool, as
the API does. Then the guest runs these steps:

1. **Before.** It creates `victim-before`, a Node object labelled as another
   pool's member. A privileged pool Pod mounts the Node's root disk, as a
   `--privileged` Job can. Using the agent's
   `client-k3s-controller.{crt,key}`, it patches the victim's `nodes/status`:
   it removes the protected membership label, adds `anycloud.sh/unusable-gpu`,
   adds another annotation, forges `Ready=False`, replaces the addresses, adds
   a finalizer and adds a flannel annotation.
2. **After.** The guest applies the product's policy and binding, then
   repeats the same patches against a fresh `victim-after`.
3. **Flannel.** It removes two of flannel's annotations from the pool Node and
   restarts `k3s-agent`. Flannel must write them back and the Node must become
   Ready again.

The guest uploads its evidence to a signed URL. `summary.json` gives each
target's HTTP codes per phase, the victim's labels, addresses and conditions,
and the flannel result. The run fails unless, on every target:

- before the policy, every patch returns 200 and the victim loses its
  membership label;
- after it, every patch except flannel's returns 403, the victim keeps its
  labels, and flannel restores its annotations on a Ready Node.

Not covered:

- **Lambda:** the certificate, its ClusterRole and the policy are the same
  K3s objects on every cloud, and Lambda Nodes join with the same script. The
  cloud only provides the VM, so the three clouds the brief names cover it.
- **The API's own install path:** the `e2e-cluster-local` check from a pool
  agent's credentials covers it.

`cleanup` deletes every AWS instance, Azure resource group, GCP instance and
GCS bucket labelled `anycloud-spike=k3s-controller-node-status`, and fails
unless none remain. Every guest also shuts down 40 minutes after boot. AWS
then terminates the instance. Re-dispatch with `arguments` `["cleanup"]` if a
run was interrupted.

## Promotion criteria

None: the `e2e-cluster-local` check in
`test/integration/e2e/internal/substrates/local-cluster/kubelet-restrictions.ts`
is the standing check.

## Deletion criteria

Delete this directory once the result is recorded.
