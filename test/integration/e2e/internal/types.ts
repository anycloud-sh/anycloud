import type {
  DedicatedWorkloadAdmissionInput,
  WorkloadAdmissionResponse,
} from '../../../../src/shared/api-contract/workload-admission-schemas.js';
import type { CloudCredential } from '../../../../src/shared/api-contract/credentials-schemas.js';
import type {
  CreateNodePoolRequest,
  NodePoolSummary,
} from '../../../../src/shared/api-contract/node-pools-schemas.js';
import type {
  WorkloadSshAccessInput,
  WorkloadSshAccessResponse,
  WorkloadStatusResponse,
} from '../../../../src/shared/api-contract/workload-management-schemas.js';

export interface CommandResult {
  readonly executable: string;
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly combined: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly outputTruncated: boolean;
  readonly spawnError?: string;
}

export interface CommandOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stdin?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly label?: string;
  /** A caller writing a consolidated retry artifact may suppress per-attempt files. */
  readonly recordArtifact?: boolean;
}

export interface LiveVmMetadata {
  readonly cloudId: string;
  readonly baseImageId: string | null;
  readonly sshHost: string;
  readonly sshPort: number;
  readonly sshUsername: string;
}

export type StatusResponse = WorkloadStatusResponse;
export type CloudCredentialInput = CloudCredential extends infer Credential
  ? Credential extends CloudCredential
    ? Omit<Credential, 'cloudProvider'> & {
        readonly cloudProvider: `${Credential['cloudProvider']}`;
      }
    : never
  : never;
export type SshAccessMaterial = WorkloadSshAccessResponse;
export type WorkloadCreateBody = DedicatedWorkloadAdmissionInput & {
  readonly id: string;
};
export type WorkloadCreateResponse = WorkloadAdmissionResponse;
export type SshAccessMode = WorkloadSshAccessInput['mode'];

export type WorkloadStatusLookup =
  | { readonly kind: 'found'; readonly status: StatusResponse }
  | { readonly kind: 'absent' };

export type { NodePoolSummary };
export type NodePoolCreateRequest = CreateNodePoolRequest;

export type NodePoolStatusLookup =
  | { readonly kind: 'found'; readonly nodePool: NodePoolSummary }
  | { readonly kind: 'absent' };

export interface DeclaredApiError {
  readonly code: string;
  readonly message: string;
  readonly status: number;
}

export interface SshAccessSummary {
  readonly workloadId?: string;
  readonly host?: string;
  readonly port?: number;
  readonly username?: string;
  readonly hasPrivateKey: boolean;
}

export interface WorkloadInspection {
  readonly args: readonly string[];
  readonly dockerSocketGroupAdded: boolean;
  readonly dockerSocketGid: string;
  readonly initEnabled: boolean;
  readonly managedLabel: string;
  readonly name: string;
  readonly path: string;
  readonly running: boolean;
  readonly workloadIdLabel: string;
  readonly roleLabel: string;
  readonly workingDirectory: string;
  readonly workspaceMode: string;
  readonly restartPolicy: string;
  readonly publishedPortCount: number;
  readonly writableWorkspaceMountCount: number;
  readonly writableDockerSocketMountCount: number;
  readonly runtimePathsAccessible: boolean;
  readonly user: string;
}

export interface WorkloadFixtureObservation {
  readonly workingDirectoryMatches: boolean;
  readonly environmentPresent: boolean;
  readonly environmentMatches: boolean;
  readonly secretPresent: boolean;
  readonly secretDigestMatches: boolean;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Also reads Vitest's serialized test errors, which aren't `Error`s. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return isRecord(error) && typeof error.message === 'string'
    ? error.message
    : String(error);
}

export function scalarString(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : '';
}
