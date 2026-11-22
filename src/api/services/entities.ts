import { type CloudType, type GpuRuntime } from '../../shared/cloud.js';
import type { BucketHostPaths } from '../../shared/providers.js';

/** The GitHub account behind a token, and the OAuth scopes GitHub lists for it. */
export interface GithubSignIn {
  id: string;
  username: string;
  scopes: readonly string[];
}

export interface User {
  /** A hosted API's immutable GitHub account id, or a local API's owner id. */
  id: string;
  username: string; // GitHub handle on a hosted API; `local` on a local API
  /** The caller's GitHub token; null on a local API without a sign-in. */
  token: string | null;
  name?: string;
  location?: string;
}

/**
 * Raw VM facts returned by a compute gateway - contains only per-VM fields.
 * Workload-level fields (vmType, cloud, spot, bucketName, etc.)
 * are stored in the workloads table and accessed via CloudConfig.
 * SSH fields are provider overrides resolved by the shared compute boundary.
 */
export interface GatewayVM {
  readonly cloudId: string; // Cloud provider's unique ID (never changes after creation)
  readonly ip: string; // Public IP address (immutable)
  privateIp?: string; // Private IP address (optional, not all VMs have private IPs)
  availabilityZone?: string; // Can vary per VM (Azure assigns, discovered after creation)
  readonly createdAt?: number; // Provider-reported creation time when known; required after database hydration
  preempted?: number; // Spot instance preemption flag (0/1, only set from DB)
  baseImageId?: string; // Concrete base AMI/offer ID used for VM creation (provenance)
  region?: string; // Region this VM was provisioned in
  sshHost?: string; // SSH host when it differs from `ip` — e.g. a provider NAT mapping. Falls back to `ip`.
  sshPort?: number; // SSH port when not 22 — e.g. a provider-mapped port. Falls back to 22.
  sshUsername?: string; // SSH username when not root — e.g. a provider whose SSH lands in a non-root sidecar. Falls back to root.
}

/**
 * Provisioned VM returned by the public compute gateway. SSH overrides have
 * been resolved into a complete endpoint at the raw gateway boundary.
 */
export interface CloudVM extends GatewayVM {
  readonly sshHost: string; // Effective host: gateway override, otherwise ip.
  readonly sshPort: number; // Effective port: gateway override, otherwise 22.
  readonly sshUsername: string; // Effective username: gateway override, otherwise root.
}

/** Resolve raw provider facts into the VM contract used by operations. */
export function resolveGatewayVM(vm: GatewayVM): CloudVM {
  if (!vm.ip) {
    throw new Error(
      `Cannot resolve gateway VM ${vm.cloudId} without an IP address`,
    );
  }
  return {
    ...vm,
    sshHost: vm.sshHost ?? vm.ip,
    sshPort: vm.sshPort ?? 22,
    sshUsername: vm.sshUsername ?? 'root',
  };
}

/** Operational VM hydrated from SQLite with persistence-owned fields. */
export interface DbVM extends CloudVM {
  readonly createdAt: number; // Required for VMs from database
  readonly preempt: number | null; // 1 when its cloud stopped it: a spot preemption, or an on-demand stop such as host maintenance (null=unknown)
  endedAt: number | null; // Per-VM spend cutoff; null while live and accruing.
  credentialId?: string; // Credential the VM booted with (NULL for legacy / failed-VM placeholders)
  cloudProvider?: CloudType; // Resolved compute provider for this VM when known.
  vmType?: string; // The VM type this attempt launched as (the attempt row's).
  inputHostPath: string; // Host path bind-mounted to /mnt/input inside the workload.
  outputHostPath: string; // Host path bind-mounted to /mnt/output inside the workload.
  checkpointHostPath: string; // Host path bind-mounted to /mnt/checkpoint inside the workload.
}

/**
 * What the orchestrator RESOLVED for a provisioning attempt — the per-attempt
 * context an attempt row records beside the gateway's `GatewayVM` facts. Kept
 * separate from `GatewayVM` so the two halves of a `vms` row are explicit in the
 * call: `vm` = what the cloud returned, `attempt` = what we chose.
 */
export interface AddVMAttempt {
  region?: string; // resolved region (authoritative; CloudVM.region is ignored)
  vmType?: string | string[]; // optimizer-resolved type; the attempt row keeps the head
  credentialId?: string; // credential the orchestrator picked for this VM
  availabilityZone?: string; // optimizer-selected zone, before provider mutation
  pricePerHour?: number; // catalog estimate
  bucketHostPaths?: BucketHostPaths; // host-side bucket paths fixed at VM creation time
}

export interface IngressRule {
  protocol: 'tcp';
  port: number;
  sourceRanges: string[];
  description?: string;
}

export interface IngressSpec {
  ingress: IngressRule[];
  /**
   * Emit an explicit deny of all public ingress on providers whose substrate
   * is a flat allow space (GCP); default-deny substrates express this by
   * creating the scope container with no allow rules.
   */
  denyPublicIngress?: boolean;
  /**
   * A VM Job's host: AWS and GCP launch it into the anycloud-owned Jobs
   * network instead of the account's default one (RFC 0053), and fail the
   * launch when that network can't be made. Azure gives every VM its own
   * network already.
   */
  jobNetwork?: boolean;
}

/**
 * Opaque provider-resource namespace. Cloud gateways may name and tag
 * resources from it, but must not infer the owning product concept.
 */
/**
 * A scope VM that still exists. `stopped` only when the cloud says so (AWS
 * `stopped`, GCP `TERMINATED`, Azure deallocated); starting, stopping and
 * unknown states count as running.
 */
export interface ResourceVM {
  readonly id: string;
  readonly stopped: boolean;
}

export interface CloudResourceScope {
  readonly id: string;
  readonly tags: Readonly<Record<string, string>>;
}

export interface CloudNetworkHandle {
  securityGroupId?: string;
  firewallRulesetIds?: string[];
  /** AWS's Jobs network: launch into the first of these subnets that takes the VM. */
  subnets?: readonly { id: string; zone: string }[];
}

/** Parameters for creating multiple VMs */
export interface NewVMsProps {
  workloadId: string;
  ipWhitelist: string[];
  startupScript: string;
  // Accelerator runtime the target must provide, or null for CPU/delegated
  // environments. CloudCompute validates this against the cloud capability
  // before raw provider code can select an incompatible image.
  gpuRuntime?: GpuRuntime | null;
  version: string;
  startIndex?: number; // Starting index for VM naming (for upgrades)
  userId: string;
  /** The provider should adopt-or-create the already-durable attempt identity. */
  adoptExistingAttempt?: boolean;
  network?: CloudNetworkHandle;
  /** Exact workload ingress intent, retained through provider VM creation. */
  ingressSpec?: IngressSpec;
  /** Present for callers using the scheduler-neutral resource-scope boundary. */
  resourceScope?: CloudResourceScope;
  /** A CPU VM Job host whose user data prepares it: the gateway launches Ubuntu minimal. */
  jobHost?: boolean;
}

/**
 * Durable identity and connection material needed to inspect an unresolved
 * provisioning attempt before repeating unrelated provider-side setup.
 */
export interface ProvisioningAttemptIdentity {
  workloadId: string;
  vmId: string;
  userId: string;
  /** Present for callers using the scheduler-neutral resource-scope boundary. */
  resourceScope?: CloudResourceScope;
}

/**
 * Stable identity for an in-flight provisioning-ledger row. The provider may
 * replace both the synthetic cloud ID and creation timestamp when launch
 * succeeds, but vmRowId continues to identify the same durable attempt. The
 * returned reference refreshes those provider-facing values for callers that
 * still need them.
 */
export interface ProvisioningAttemptRef {
  vmRowId: number;
  cloudId: string;
  createdAt: number;
}

/** Parameters for creating a single VM (includes vmId) */
export type NewVMProps = NewVMsProps & { vmId: string };
