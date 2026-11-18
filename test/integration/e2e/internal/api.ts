import { ORPCError } from '@orpc/client';
import type { ClusterSummary } from '../../../../src/shared/api-contract/clusters-schemas.js';

import {
  createApiClient,
  type ApiClient as ContractApiClient,
} from '../../../../src/shared/services/api-client/rpc.js';
import {
  cloudCredentialSchema,
  credentialListSchema,
  redactedCredentialSchema,
  type RedactedCredential,
} from '../../../../src/shared/api-contract/credentials-schemas.js';
import type { WorkloadAdmissionInput } from '../../../../src/shared/api-contract/workload-admission-schemas.js';
import { bucketItemSchema } from '../../../../src/shared/api-contract/bucket-metadata-schemas.js';

import type { ArtifactStore, Redactor } from './artifacts.js';
import {
  controllerEndpointSource,
  type ControllerEndpointSource,
} from './controller-session.js';
import type {
  CloudCredentialInput,
  DeclaredApiError,
  WorkloadCreateBody,
  WorkloadCreateResponse,
  WorkloadStatusLookup,
  SshAccessMaterial,
  SshAccessMode,
  SshAccessSummary,
  StatusResponse,
} from './types.js';
import { isRecord } from './types.js';

const SENSITIVE_CREDENTIAL_FIELD =
  /(?:access.?key|api.?key|credential|password|private.?key|secret|token)/iu;
const API_OPERATION_TIMEOUT_MS = 60_000;
const VERBOSE_STATUS_TIMEOUT_MS = 20_000;

export interface BucketPresenceObservation {
  readonly name: string;
  readonly credentialName: string;
  readonly region: string;
  readonly presence: 'present' | 'absent';
  readonly controller: Readonly<{ generation: number; url: string }>;
}

function sshSummary(material: SshAccessMaterial): SshAccessSummary {
  return {
    workloadId: material.workloadId,
    host: material.sshHost ?? material.vmIp,
    ...(typeof material.sshPort === 'number' ? { port: material.sshPort } : {}),
    ...(material.sshUsername ? { username: material.sshUsername } : {}),
    hasPrivateKey: material.sshPrivateKey.length > 0,
  };
}

function errorArtifact(error: unknown): Readonly<Record<string, unknown>> {
  if (error instanceof ORPCError) {
    return {
      name: error.name,
      message: error.message,
      code: error.code,
      status: error.status,
      defined: error.defined,
    };
  }
  // A transport failure's own message is generic; its cause names it.
  const cause: unknown = error instanceof Error ? error.cause : undefined;
  const causeCode =
    cause && typeof cause === 'object' && 'code' in cause
      ? cause.code
      : undefined;
  return {
    name: error instanceof Error ? error.name : 'UnknownError',
    message: error instanceof Error ? error.message : String(error),
    ...(typeof causeCode === 'string' ? { causeCode } : {}),
  };
}

export function declaredApiError(error: unknown): DeclaredApiError | undefined {
  if (!(error instanceof ORPCError) || !error.defined) return undefined;
  const candidate: unknown = error;
  if (
    !candidate ||
    typeof candidate !== 'object' ||
    !('code' in candidate) ||
    typeof candidate.code !== 'string' ||
    !('status' in candidate) ||
    typeof candidate.status !== 'number'
  ) {
    return undefined;
  }
  return {
    code: candidate.code,
    message: error.message,
    status: candidate.status,
  };
}

function isWorkloadAbsent(error: unknown): boolean {
  const declared = declaredApiError(error);
  return (
    declared?.code === 'WORKLOAD_MANAGEMENT_NOT_FOUND' &&
    declared.status === 404
  );
}

interface CachedClient {
  generation: number;
  bearer: string;
  client: ContractApiClient;
}

export class ApiClient {
  readonly #endpoint: ControllerEndpointSource;
  /** The bearer for a controller URL: it changes when an upgrade restarts it. */
  readonly #bearer: (url: string) => string;
  readonly #artifacts: ArtifactStore;
  readonly #artifactPrefix: string;
  readonly #redactor: Redactor;
  readonly #signal: AbortSignal;
  #client: CachedClient | undefined;
  #verboseStatusClient: CachedClient | undefined;
  #requestCount = 0;
  /**
   * The latest fetch failure. The client retries a dropped connection until
   * the caller's deadline, which then surfaces only as a TimeoutError.
   */
  #lastTransportFailure: unknown;

  constructor(
    endpoint: string | undefined | ControllerEndpointSource,
    token: string | ((url: string) => string),
    artifacts: ArtifactStore,
    redactor: Redactor,
    signal: AbortSignal = new AbortController().signal,
    artifactPrefix = 'api',
  ) {
    this.#endpoint = controllerEndpointSource(endpoint);
    this.#bearer = typeof token === 'string' ? () => token : token;
    this.#artifacts = artifacts;
    this.#artifactPrefix = artifactPrefix;
    this.#redactor = redactor;
    this.#signal = signal;
  }

  get url(): string {
    return this.#requiredEndpoint().url;
  }

  get controller(): Readonly<{ generation: number; url: string }> {
    const { generation, url } = this.#requiredEndpoint();
    return Object.freeze({ generation, url });
  }

  async saveCredential(
    name: string,
    credential: CloudCredentialInput,
    options: {
      readonly overwrite?: boolean;
      readonly deadlineAt?: number;
    } = {},
  ): Promise<void> {
    const canonicalCredential = cloudCredentialSchema.parse(credential);
    for (const [key, value] of Object.entries(canonicalCredential)) {
      if (SENSITIVE_CREDENTIAL_FIELD.test(key) && typeof value === 'string') {
        this.#redactor.add(value);
      }
    }
    const endpoint = this.#requiredEndpoint();
    const artifactName = this.#artifactName('save-credential');
    try {
      await this.#defaultClient().credentials.save(
        {
          params: { name },
          query:
            options.overwrite === undefined
              ? {}
              : { overwrite: options.overwrite ? 'true' : 'false' },
          body: canonicalCredential,
        },
        { signal: this.#operationSignal(options.deadlineAt) },
      );
      this.#assertEndpoint(endpoint);
      if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt)
        throw new Error('Credential save exceeded its deadline');
    } catch {
      await this.#artifacts.json(artifactName, { name, state: 'unknown' });
      throw new Error('Credential save did not complete');
    }
    await this.#artifacts.json(artifactName, {
      name,
      cloudProvider: canonicalCredential.cloudProvider,
      state: 'saved',
    });
  }

  /** The redacted record; the API never returns credential material. */
  async readCredential(
    name: string,
    deadlineAt: number,
  ): Promise<Readonly<RedactedCredential> | undefined> {
    const artifactName = this.#artifactName('credential-readback');
    const endpoint = this.#requiredEndpoint();
    let credential: RedactedCredential;
    try {
      credential = redactedCredentialSchema.parse(
        await this.#defaultClient().credentials.get(
          { params: { name } },
          { signal: this.#operationSignal(deadlineAt) },
        ),
      );
      this.#assertEndpoint(endpoint);
      if (credential.name !== name)
        throw new Error('Credential readback returned another identity');
      if (Date.now() >= deadlineAt)
        throw new Error('Credential readback exceeded its deadline');
    } catch (cause) {
      const declared = declaredApiError(cause);
      if (
        declared?.code === 'CREDENTIAL_NOT_FOUND' &&
        declared.status === 404 &&
        cause instanceof ORPCError &&
        isRecord(cause.data) &&
        cause.data.name === name &&
        Date.now() < deadlineAt &&
        this.#sameEndpoint(endpoint)
      ) {
        await this.#artifacts.json(artifactName, {
          name,
          state: 'absent',
          declaredCode: declared.code,
        });
        return undefined;
      }
      // An unvalidated response or provider diagnostic can contain newly issued
      // material. Keep it private even when its values are not yet known.
      await this.#artifacts.json(artifactName, {
        name,
        state: 'unknown',
        ...(declared && [401, 403, 404].includes(declared.status)
          ? { status: declared.status }
          : {}),
      });
      // Reporters recursively print causes. Unvalidated material must not cross
      // this boundary through an Error either, even when artifacts are private.
      throw new Error('Credential readback failed');
    }
    await this.#artifacts.json(artifactName, {
      name,
      cloudProvider: credential.cloudProvider,
      state: 'present',
    });
    return Object.freeze(credential);
  }

  async listCredentials(
    deadlineAt: number,
  ): Promise<readonly RedactedCredential[]> {
    const artifactName = this.#artifactName('credential-inventory');
    const endpoint = this.#requiredEndpoint();
    let summaries: RedactedCredential[];
    try {
      summaries = credentialListSchema.parse(
        await this.#defaultClient().credentials.list(undefined, {
          signal: this.#operationSignal(deadlineAt),
        }),
      );
      this.#assertEndpoint(endpoint);
      if (
        new Set(summaries.map((entry) => entry.name)).size !== summaries.length
      )
        throw new Error('Credential inventory repeats an identity');
      if (Date.now() >= deadlineAt)
        throw new Error('Credential inventory exceeded its deadline');
    } catch {
      await this.#artifacts.json(artifactName, {
        complete: false,
      });
      throw new Error('Credential inventory did not complete');
    }
    await this.#artifacts.json(artifactName, {
      complete: true,
      identities: summaries.map(({ name, cloudProvider }) => ({
        name,
        cloudProvider,
      })),
    });
    return summaries;
  }

  async deleteCredential(name: string, deadlineAt: number): Promise<void> {
    const artifactName = this.#artifactName('delete-credential');
    const endpoint = this.#requiredEndpoint();
    try {
      await this.#defaultClient().credentials.delete(
        { params: { name }, query: { force: 'true' } },
        { signal: this.#operationSignal(deadlineAt) },
      );
      this.#assertEndpoint(endpoint);
    } catch {
      await this.#artifacts.json(artifactName, { name, state: 'unknown' });
      throw new Error('Credential deletion failed');
    }
    await this.#artifacts.json(artifactName, {
      name,
      state: 'delete-returned',
    });
    const summaries = await this.listCredentials(deadlineAt);
    this.#assertEndpoint(endpoint);
    if (summaries.some((entry) => entry.name === name))
      throw new Error('Credential remains after deletion');
    if (await this.readCredential(name, deadlineAt))
      throw new Error('Credential remains readable after deletion');
    this.#assertEndpoint(endpoint);
  }

  async bucketPresence(
    name: string,
    credentialName: string,
    region: string,
    deadlineAt: number,
  ): Promise<BucketPresenceObservation> {
    const artifactName = this.#artifactName('bucket-presence');
    const controller = this.#requiredEndpoint();
    const startedAt = Date.now();
    this.#lastTransportFailure = undefined;
    let presence: BucketPresenceObservation['presence'];
    try {
      const item = bucketItemSchema.parse(
        await this.#defaultClient().bucket.exists(
          { params: { bucketName: name, credentialName }, query: { region } },
          { signal: this.#operationSignal(deadlineAt) },
        ),
      );
      this.#assertEndpoint(controller);
      if (item.name !== name || Date.now() >= deadlineAt)
        throw new Error(
          'Bucket readback returned another identity or exceeded its deadline',
        );
      presence = 'present';
    } catch (error) {
      const declared = declaredApiError(error);
      if (
        declared?.code === 'BUCKET_NOT_FOUND' &&
        declared.status === 404 &&
        Date.now() < deadlineAt &&
        this.#sameEndpoint(controller)
      ) {
        presence = 'absent';
      } else {
        await this.#artifacts.json(artifactName, {
          name,
          credentialName,
          region,
          controller,
          presence: 'unknown',
          failure: errorArtifact(error),
          // Best effort: the field is shared by every call on this client,
          // so a concurrent call can overwrite or clear it.
          ...(this.#lastTransportFailure === undefined
            ? {}
            : {
                lastTransportFailure: errorArtifact(this.#lastTransportFailure),
              }),
          elapsedMs: Date.now() - startedAt,
          deadlineRemainingMs: deadlineAt - Date.now(),
        });
        throw new Error(
          'Bucket API readback did not establish its exact presence',
        );
      }
    }
    const observation = Object.freeze({
      name,
      credentialName,
      region,
      presence,
      controller: Object.freeze({ ...controller }),
    });
    await this.#artifacts.json(artifactName, observation);
    return observation;
  }

  async createWorkload(
    body: WorkloadCreateBody,
  ): Promise<WorkloadCreateResponse> {
    if ('workload' in body) {
      throw new Error(
        'The direct-workload E2E helper cannot submit a targeted Job',
      );
    }
    return this.#record('create-workload', body, () =>
      this.#defaultClient().admission.submit(body as WorkloadAdmissionInput, {
        signal: this.#operationSignal(),
      }),
    );
  }

  async listClusters(): Promise<readonly ClusterSummary[]> {
    const response = await this.#record('list-clusters', {}, () =>
      this.#defaultClient().clusters.list(undefined, {
        signal: this.#operationSignal(),
      }),
    );
    return response.clusters;
  }

  async createSecret(
    name: string,
    values: Readonly<Record<string, string>>,
  ): Promise<void> {
    const endpoint = this.#requiredEndpoint();
    for (const value of Object.values(values)) this.#redactor.add(value);
    const request = { name, values: { ...values } };
    await this.#record('create-secret', request, () =>
      this.#defaultClient().secrets.save(
        {
          params: { name },
          body: { values: request.values },
        },
        { signal: this.#operationSignal() },
      ),
    );
    this.#assertEndpoint(endpoint);
  }

  async deleteSecret(
    name: string,
    deadlineAt?: number,
    options: { readonly force: boolean } = { force: true },
  ): Promise<void> {
    const endpoint = this.#requiredEndpoint();
    const signal = this.#operationSignal(deadlineAt);
    await this.#record('delete-secret', { name, force: options.force }, () =>
      this.#defaultClient().secrets.delete(
        {
          params: { name },
          query: options.force ? { force: 'true' } : {},
        },
        { signal },
      ),
    );
    this.#assertEndpoint(endpoint);
    const summaries = await this.#record(
      'verify-secret-absence',
      { name },
      () =>
        this.#defaultClient().secrets.list(undefined, {
          signal,
        }),
    );
    this.#assertEndpoint(endpoint);
    if (summaries.some((summary) => summary.name === name)) {
      throw new Error('Named secret remains after deletion');
    }
  }

  async status(id: string, verbose = false): Promise<StatusResponse> {
    const lookup = await this.lookupStatus(id, verbose);
    if (lookup.kind === 'absent') {
      throw new Error(`Workload ${id} was not found`);
    }
    return lookup.status;
  }

  async lookupStatus(
    id: string,
    verbose = false,
    deadlineAt?: number,
  ): Promise<WorkloadStatusLookup> {
    const request = { id, verbose };
    try {
      const status = await this.#record('workload-status', request, () =>
        this.#statusClient(verbose).workloads.status(
          {
            params: { id },
            // Fences and baselines read the whole history, not the recent tail.
            query: { verbose: verbose ? 'true' : 'false', eventsLimit: 'all' },
          },
          { signal: this.#operationSignal(deadlineAt) },
        ),
      );
      return { kind: 'found', status };
    } catch (error) {
      if (isWorkloadAbsent(error)) return { kind: 'absent' };
      throw error;
    }
  }

  async sshAccess(id: string, mode: SshAccessMode): Promise<SshAccessMaterial> {
    const request = { id, mode };
    return this.#record('ssh-access', request, () =>
      this.#defaultClient().workloads.sshAccess(
        {
          params: { id },
          query: { mode },
        },
        { signal: this.#operationSignal() },
      ),
    );
  }

  async sshAccessSummary(
    id: string,
    mode: SshAccessMode,
  ): Promise<SshAccessSummary> {
    return sshSummary(await this.sshAccess(id, mode));
  }

  async sshAccessRejection(
    id: string,
    mode: SshAccessMode,
  ): Promise<DeclaredApiError> {
    try {
      await this.sshAccess(id, mode);
    } catch (error) {
      const declared = declaredApiError(error);
      if (declared) return declared;
      throw error;
    }
    throw new Error(`SSH access for ${id} in ${mode} mode unexpectedly passed`);
  }

  #defaultClient(): ContractApiClient {
    this.#client = this.#current(this.#client, (bearer, apiUrl) =>
      createApiClient(bearer, {
        apiUrl,
        fetch: async (request, init) => {
          try {
            return await fetch(request, { ...init, redirect: 'error' });
          } catch (error) {
            // The deadline's own abort is already the call's error.
            if (!init?.signal?.aborted) this.#lastTransportFailure = error;
            throw error;
          }
        },
      }),
    );
    return this.#client.client;
  }

  #statusClient(verbose: boolean): ContractApiClient {
    if (!verbose) return this.#defaultClient();
    this.#verboseStatusClient = this.#current(
      this.#verboseStatusClient,
      (bearer, apiUrl) =>
        createApiClient(bearer, {
          apiUrl,
          requestTimeoutMs: VERBOSE_STATUS_TIMEOUT_MS,
        }),
    );
    return this.#verboseStatusClient.client;
  }

  /** Reuses a client until an upgrade moves the controller or replaces its bearer. */
  #current(
    cached: CachedClient | undefined,
    create: (bearer: string, apiUrl: string) => ContractApiClient,
  ): CachedClient {
    const endpoint = this.#requiredEndpoint();
    const bearer = this.#bearer(endpoint.url);
    if (cached?.generation === endpoint.generation && cached.bearer === bearer)
      return cached;
    const client = create(bearer, endpoint.url);
    return { generation: endpoint.generation, bearer, client };
  }

  #requiredEndpoint(): Readonly<{ generation: number; url: string }> {
    const endpoint = this.#endpoint.snapshot();
    if (!endpoint) {
      throw new Error(
        'API_URL is required for this E2E capability; run via e2e.sh',
      );
    }
    return endpoint;
  }

  #sameEndpoint(
    expected: Readonly<{ generation: number; url: string }>,
  ): boolean {
    const actual = this.#endpoint.snapshot();
    return (
      actual?.generation === expected.generation && actual.url === expected.url
    );
  }

  #assertEndpoint(
    expected: Readonly<{ generation: number; url: string }>,
  ): void {
    if (!this.#sameEndpoint(expected))
      throw new Error(
        'Credential operation changed its controller incarnation',
      );
  }

  #operationSignal(deadlineAt?: number): AbortSignal {
    const timeoutMs =
      deadlineAt === undefined
        ? API_OPERATION_TIMEOUT_MS
        : Math.min(API_OPERATION_TIMEOUT_MS, deadlineAt - Date.now());
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
      throw new Error('API operation deadline expired or is invalid');
    return AbortSignal.any([this.#signal, AbortSignal.timeout(timeoutMs)]);
  }

  async #record<T>(
    operation: string,
    request: unknown,
    invoke: () => Promise<T>,
  ): Promise<T> {
    const artifactName = this.#artifactName(operation);
    try {
      const response = await invoke();
      await this.#artifacts.json(artifactName, {
        operation,
        request,
        response,
      });
      return response;
    } catch (error) {
      await this.#artifacts.json(artifactName, {
        operation,
        request,
        error: errorArtifact(error),
      });
      throw error;
    }
  }

  #artifactName(operation: string): string {
    this.#requestCount += 1;
    return `${String(this.#requestCount).padStart(3, '0')}-${this.#artifactPrefix}-${operation}`;
  }
}
