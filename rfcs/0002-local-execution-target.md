# RFC 0002: Local VM-host test harness

> Status: Superseded
> Date: 2026-06-15
> Author: Luis Fernando De Pombo
> Updated: 2026-08-18 for cold boots from a COW golden disk image.

> Supersession: The public Local execution product was removed. The provider
> identity now exists only as the undocumented smolvm test harness recorded here.

## Summary

The API-host Docker execution product is retired. The shipped CLI has no Local
compute selector, local API startup has no Docker enablement flag, and API
containers do not receive the host Docker socket. The separate Docker-control
image, release jobs, host volume, and control network are removed.

A credentialless CLI request is left unplaced only when no saved compute
credentials exist. The API may then select Local after the fixed SmolVM runtime
passes its capability preflight; saved credentials retain normal selection.

Keep `CloudType.Local` in the TypeScript provider registry, persisted request
model, and Python SDK. It is useful for compatibility and for test requests,
but it is intentionally absent from user documentation and CLI help.

For integration coverage, `Local` now creates disposable Linux microVMs through
a separately prepared smolvm service:

```text
test runner
  -> loopback-only smolvm service
  -> one disposable Linux microVM per deployment VM
  -> root SSH with the deployment key
  -> normal Anycloud VM initialization
  -> Docker workload + sentinels inside the microVM
```

This keeps real coverage of the production VM-host path without giving the API
container host-root-equivalent Docker access.

## Scope

The retained harness must cover:

- credentialless `CloudType.Local` request and persistence behavior;
- provider preflight, microVM creation, start, inspect, stop, and delete;
- SSH bootstrap and the normal SSH transport;
- verbatim delivery of the provider-neutral VM startup script;
- Docker installation/readiness, image pull, workload start, secrets, logs,
  exec, sentinels, completion, termination, and resubmit;
- input hydration and output/checkpoint synchronization through the normal
  deployment storage and rclone pipeline;
- API-only Service ingress through a second smolvm mapping from a random
  loopback host port to guest TCP/80;
- restart-safe Service recovery from `Starting`, replacement upgrades, and
  complete release of every forwarded port;
- restart-safe deployment monitoring through the shared provider contract;
- age-guarded and prefix-scoped orphan cleanup;
- the Python SDK Local contract lane and the runner-bounded Local nuke lane.

It is not a supported workload destination. Local Service ingress exists only
for the internal API test harness: it has no public endpoint, public CLI
selector, DNS record, user SSH access, GPU qualification lane, hosted-API Local
runtime, or automatic developer-machine setup.

## Availability contract

Local is always registered and each gateway owns a client configured from
fixed code constants; it does not read process environment. Selecting Local
performs the ordinary health and capability preflight against the loopback
SmolVM service. If that substrate is absent or incompatible, the request fails
clearly with `Local compute is unavailable on this API server.`

`IS_TEST` controls unrelated test authentication and diagnostics and does not
change provider construction or availability. Local remains absent from public
CLI selectors, and neither `anycloud api start` nor `anycloud api serve` starts
the privileged host service.

Before the first VM create, the provider runs a cached capability preflight:

1. call smolvm health and require the pinned compatible version;
2. create a uniquely named smoke VM from the digest-checked sidecar;
3. start it and resolve its mapped SSH port;
4. execute the same generated startup script used by cloud gateways;
5. connect through the production SSH transport;
6. verify the image version, pinned Docker/rclone versions, storage layout,
   freshly generated deployment key, and authorized key;
7. stop and delete the smoke VM even when a stage fails.

Concurrent callers share the same preflight promise for one runtime
configuration. A failed preflight is not cached.

## Provider contract

`Local` remains a normal credentialless `CloudCompute` implementation with
`region=local` and `vmType=local`. It uses the standard VM-host validation and
deployment pipeline. The provider-specific work is limited to the machine
lifecycle and endpoint mapping.

Machine names are derived from the provider-owned `ac-local-` prefix plus the
deployment and VM identity. Every preflight and workload sends an ordinary
create request with `from` set to the versioned `.smolmachine`, then starts the
new VM normally. The image is stopped and contains no memory snapshot. On
Linux, SmolVM materializes each packed sparse disk once as an immutable,
content-addressed raw base and creates private qcow2 overlays for each machine.
There is no running golden lifecycle, frozen state, fork endpoint, semaphore,
or clone-readiness retry.

Create requests enable virtio networking and mount only the fixed host bucket
root at `/var/lib/anycloud/buckets`. Jobs map guest SSH port 22 to one randomly
selected loopback host port. Services additionally map guest TCP/80 to a
distinct random loopback host port. The full mapping is allocated inside each
cold-create retry; bind conflicts are cleaned up and retried with an entirely
new mapping. Allocator results must be integers in the reserved range, and
duplicate pair draws are bounded so a deterministic allocator cannot loop
forever. The smoke preflight has its own independent SSH-port allocation.

The provider sends `params.startupScript` unchanged to `/bin/bash -s` in every
new machine through smolvm exec. The packed image has no machine identity, SSH
host keys, authorized keys, or credentials, so that script mints machine
identity and host keys on its private disk, configures the deployment SSH key,
retains `/etc/anycloud-key` only for managed workloads, and starts sshd before
the provider returns:

- smolvm machine name as `cloudId`;
- configured loopback hostname as `sshHost`;
- assigned host port as `sshPort`;
- `root` as the SSH username.

Using `localhost` rather than the Docker manager's special `127.0.0.1` value is
intentional: it forces the normal remote-SSH path even though the mapped port is
on loopback.

The provider publishes no public endpoint. It accepts exactly one TCP/22 rule
with an optional TCP/80 rule; empty, HTTP-only, duplicate, malformed, and all
other protocol/port shapes are rejected by the same predicate at submit time
and runtime. An omitted ingress spec at the direct gateway boundary means
SSH-only Job intent. `CloudNetworkHandle` remains provider-network state and
does not carry this intent. User SSH remains unsupported so mapped endpoints
and key material stay behind the API boundary. Logs and exec still work because
the API uses its stored VM key.

Termination stops and force-deletes the named microVM. Status maps smolvm
not-found to terminated, a present machine to alive, and transport failures to
an unknown termination result so the shared reconciler does not falsely mark a
VM gone.

## Guest bootstrap and Docker

The CI setup pins SmolVM and verifies its release checksums. It cold-boots one
build VM, installs the cloud-image prerequisites and checksum-pinned Docker and
rclone versions, and places Docker's `overlay2` data root on the ext4
`/storage/docker` disk. It pulls and executes `busybox:1.36`, then stops the
daemon and scrubs SSH host keys, machine identity, authorized keys,
credentials, PID files, sockets, and temporary data. The stopped VM is packed
as a versioned sidecar with a SHA-256 marker before the loopback service starts.

Every workload receives the production startup script and calls the normal
`initializeVM`. Its existing Docker/rclone probes take the installed fast path;
on minimal non-systemd guests it starts `dockerd` with `overlay2` and
`/storage/docker`. `vfs` under `/var/lib/docker` remains only the fallback when
the ext4 storage mount is absent. Workload state and cached image layers live
on each machine's private storage overlay.

The startup contract retains one source-less, low-width bare-image run. It
installs Docker and rclone through the unchanged production vendor URLs, so the
vendor-download path remains covered without reinstalling identical host
tooling across the nuke. The prepared-image portion then verifies two cold
boots receive distinct host/deployment keys and exercises minimal, non-root,
and Docker CLI container profiles.

The guest's Docker daemon is isolated from the CI host Docker daemon. The API
container never mounts `/var/run/docker.sock` from the host.

## Storage contract

Local deployment storage is a filesystem-backed `CloudStorage` implementation
rooted at `/var/lib/anycloud-test/local/buckets`. The same root is mounted into
each guest at `/var/lib/anycloud/buckets`; rclone therefore follows the normal
provider-neutral configuration and `/mnt/input`, `/mnt/output`, and
`/mnt/checkpoint` behavior. The Job E2E proves input download-once semantics,
checkpoint hydration, and continuous output/checkpoint upload from the user
container. This store is internal harness plumbing, not a public Local bucket
credential or CLI surface.

## Coverage boundary

The bare-installer and prepared-image startup contracts plus Local E2E cover
the behavior Anycloud owns:
startup-script contents, SSH readiness, `initializeVM`, Docker/rclone setup,
sync orchestration, and workload execution. Compared with the retired Docker
vmstartup fixture, smolvm additionally covers a real microVM boot, isolated
guest filesystem/kernel, forwarded networking, and machine lifecycle.

The single bare contract covers the public HTTPS transfer, extraction, and
installation of Docker and rclone. The prepared-image lanes cover the installed
fast paths, daemon readiness, workload execution, and later guest networking.
Real cloud initialization retains the same vendor HTTPS source.

Neither local harness can validate behavior owned by a cloud control plane:
native user-data/cloud-init transport, instance identity and IAM, provider
network/firewall behavior, spot/preemption signals, or a cloud image's real
systemd/cloud-init services. Those remain assertions for the real AWS, Azure,
and GCP integration lanes.

## Cleanup ownership

Cleanup may act only on machine names with the provider-owned prefix. Normal
orphan cleanup retains the shared age guard, while explicit CI teardown may
remove every prefixed machine by passing a null age threshold. Cleanup lists
what it would remove in dry-run mode and tolerates already-missing machines.

The setup and teardown commands are test infrastructure:

```text
yarn local-runtime:setup
yarn test:local-smolvm:runtime
test/integration/e2e.sh local-smolvm-job
test/integration/e2e.sh local-smolvm-serve
yarn local-runtime:cleanup
```

They require Linux, writable KVM, and elevated host access to install the
loopback smolvm service and its state under `/var/lib/anycloud-test/local`.

## Security consequences

The retired design mounted the host Docker socket into a credential-holding API
container. Access to that socket is effectively host-root access and made an
API compromise a host compromise. Removing the mount, control image, and
automatic hosted/local API wiring eliminates that shipped privilege boundary.

The replacement still executes arbitrary test workload images, but each runs
inside a disposable KVM guest on a CI runner. The smolvm management API is bound
to loopback and is provided only to isolated harness jobs. The runner sidecar
and its public build inputs are checksum-pinned and are not exposed through the
Local object store. CI cleanup is prefix-scoped and runs even after failure.

## Decision

The public API-host Local execution product and Docker-control substrate are
removed. `CloudType.Local` remains an undocumented, capability-configured
provider used by the smolvm Job, API-only Service, and Python SDK test lanes. No
`IS_TEST` gate is added. The dedicated Service lane proves `Starting` recovery,
upgrade replacement, the null URL/DNS boundary, and cleanup without adding a
public Local Service surface.
