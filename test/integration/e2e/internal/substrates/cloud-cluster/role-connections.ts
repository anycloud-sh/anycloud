import { CoreV1Api, type KubeConfig } from '@kubernetes/client-node';
import { randomUUID } from 'node:crypto';

import { ORPCError } from '@orpc/client';

import { createApiClient } from '../../../../../../src/shared/services/api-client/rpc.js';
import { SYSTEM_RELEASE_NAMESPACE } from '../../../../../../src/shared/system-release.js';
import type { CloudCredential } from '../../../../../../src/shared/api-contract/credentials-schemas.js';
import {
  isTerminalState,
  WorkloadState,
} from '../../../../../../src/shared/workload.js';
import type { ArtifactStore } from '../../artifacts.js';
import type { CleanupStack } from '../../cleanup.js';
import type { ServiceAccountIssuerRecord } from '../../contracts/cluster-cloud.js';
import type {
  MintOutcome,
  StorageTokenGrant,
} from '../../contracts/storage-tokens.js';
import { MintedTokens } from '../../transports/storage-tokens.js';
import type {
  ExchangeOutcome,
  RoleCloud,
  RoleConnectionsPort,
  SaveOutcome,
  TokenSubject,
  TrustVariant,
} from '../../contracts/role-connections.js';
import type { CliClient } from '../../cli.js';
import { cliArgs } from '../../cli-surface.js';
import type { ProcessRunner } from '../../process.js';
import type { Waiter } from '../../wait.js';
import { CHECK_IMAGE } from '../../contracts/job-policy.js';
import type { HostedApiStage } from './hosted-stage.js';
import { pendingLanes } from './role-pending-lanes.js';
import {
  cloudTrust,
  type CloudTrust,
  type DeployedTrust,
} from './role-trusts.js';

/** Where the hosted API serves each cloud's setup template (lane R1). */
const SETUP_PATHS: Readonly<Record<RoleCloud, string>> = {
  aws: '/role-setup/aws.json',
  gcp: '/role-setup/gcp.sh',
  azure: '/role-setup/azure.json',
};

/** Lane R3's probe ServiceAccount and audience. */
const PROBE = {
  serviceAccount: 'anycloud-trust-probe',
  subject: 'system:serviceaccount:anycloud-system:anycloud-trust-probe',
  audience: 'anycloud-trust-probe',
} as const;

interface Deployment {
  readonly trust: CloudTrust;
  readonly deployed: DeployedTrust;
  readonly name: string;
  /** Removes the trust now, proving it gone, and releases its cleanup. */
  readonly registration: { complete(): Promise<void> };
}

/** Where each cloud's output bucket lives. */
export interface RoleRegions {
  readonly aws: string;
  readonly gcp: string;
  readonly azure: string;
}

export interface CloudRoleConnectionsOptions {
  readonly hosted: Pick<
    HostedApiStage,
    | 'checkJob'
    | 'status'
    | 'logs'
    | 'readBucketObject'
    | 'bucketDeletion'
    | 'seedBucket'
  >;
  readonly hostedUrl: () => string;
  /** This tree's CLI: the hosted API by its URL, the installer without. */
  readonly cli: Pick<CliClient, 'run'>;
  readonly issuer: () => Promise<ServiceAccountIssuerRecord>;
  readonly kubeConfig: () => Promise<KubeConfig>;
  /** The run's CI credential per cloud, which deploys, changes and deletes each trust. */
  readonly credentials: Readonly<Record<RoleCloud, CloudCredential>>;
  readonly regions: RoleRegions;
  readonly runner: Pick<ProcessRunner, 'run'>;
  readonly artifacts: Pick<ArtifactStore, 'json'>;
  readonly cleanup: Pick<CleanupStack, 'defer'>;
  readonly wait: Pick<Waiter, 'for'>;
  readonly workloadMs: number;
}

/** A run-unique object name: `e2e-role-<ms>-<rand>`, as the stale sweep parses. */
export function roleObjectName(now = Date.now()): string {
  return `e2e-role-${String(now)}-${randomUUID().slice(0, 4)}`;
}

/**
 * The role-connection checks' port: each trust through its cloud's own
 * template and the run's CI credential, tokens through the installer's
 * connection to the hosted cluster, and every save, Job and bucket through
 * the hosted API with this tree's CLI.
 */
export class CloudRoleConnections implements RoleConnectionsPort {
  readonly #o: CloudRoleConnectionsOptions;
  readonly #trusts = new Map<RoleCloud, Promise<Deployment>>();
  readonly #lanes;
  readonly #next = new Map<RoleCloud, string>();
  readonly #settled = new Map<
    RoleCloud,
    { deployed: DeployedTrust; name: string }
  >();
  #minted: MintedTokens | undefined;

  constructor(options: CloudRoleConnectionsOptions) {
    this.#o = options;
    this.#lanes = pendingLanes({
      cli: options.cli,
      hostedUrl: options.hostedUrl,
    });
  }

  #deployed(cloud: RoleCloud) {
    const deployed = this.#trusts.get(cloud);
    if (!deployed)
      throw new Error(`the ${cloud} trust is used before it is deployed`);
    return deployed;
  }

  async trust(cloud: RoleCloud): Promise<void> {
    if (!this.#trusts.has(cloud)) {
      this.#next.set(cloud, roleObjectName());
      this.#trusts.set(cloud, this.#deploy(cloud, roleObjectName()));
    }
    await this.#trusts.get(cloud);
  }

  /**
   * S16's compromise arm: the trust revoked, proven gone, and recreated from
   * the template under the name `audience(cloud, 'replacement')` was read for.
   */
  async replaceTrust(cloud: RoleCloud): Promise<void> {
    const current = await this.#deployed(cloud);
    await current.registration.complete();
    const name = this.#next.get(cloud)!;
    this.#next.set(cloud, roleObjectName());
    this.#trusts.set(cloud, this.#deploy(cloud, name));
    await this.#trusts.get(cloud);
  }

  async #deploy(cloud: RoleCloud, name: string): Promise<Deployment> {
    const { issuer } = await this.#o.issuer();
    const trust = cloudTrust(
      cloud,
      {
        name,
        issuer,
        runner: this.#o.runner,
        probe: PROBE,
        wait: this.#o.wait,
      },
      this.#o.credentials[cloud],
    );
    // Registered first, so a failed deployment still deletes what it made.
    const remove = async () => {
      const gone = await trust.remove();
      await this.#o.artifacts.json(`role-trust-${name}-removed`, {
        cloud,
        name,
        gone,
      });
    };
    const deferred = this.#o.cleanup.defer(
      `${cloud} role trust ${name}`,
      remove,
    );
    const registration = {
      complete: async () => {
        await remove();
        deferred.complete();
      },
    };
    // On record before anything exists: the workflow's sweep reads it.
    await this.#o.artifacts.json(`role-trust-${name}`, { cloud, name });
    const response = await fetch(
      `${this.#o.hostedUrl()}${SETUP_PATHS[cloud]}`,
      {
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok)
      throw new Error(
        `the hosted API answered ${response.status} for ${SETUP_PATHS[cloud]}; its setup templates come with lane R1`,
      );
    const deployed = await trust.deploy(await response.text());
    this.#settled.set(cloud, { deployed, name });
    await this.#o.artifacts.json(`role-trust-${name}`, {
      cloud,
      name,
      ...deployed,
    });
    return { trust, deployed, name, registration };
  }

  async applyVariant(
    cloud: RoleCloud,
    variant: TrustVariant,
  ): Promise<string | undefined> {
    return (await this.#deployed(cloud)).trust.apply(variant);
  }

  async save(
    cloud: RoleCloud,
    name: string,
    api: 'hosted' | 'local',
  ): Promise<SaveOutcome> {
    // The local API refuses before it reads a trust; give it the shape of one.
    const identifiers =
      api === 'local' && !this.#trusts.has(cloud)
        ? LOCAL_IDENTIFIERS[cloud]
        : (await this.#deployed(cloud)).deployed.identifiers;
    return this.#lanes.save(cloud, name, identifiers, api);
  }

  audience(
    cloud: RoleCloud,
    trust: 'current' | 'replacement' = 'current',
  ): string {
    const deployed = this.#settled.get(cloud);
    if (!deployed)
      throw new Error(
        `the ${cloud} trust's audience is read before it is deployed`,
      );
    // Only GCP's audience names the trust: its pool and provider IDs.
    return trust === 'current'
      ? deployed.deployed.audience
      : deployed.deployed.audience.replaceAll(
          deployed.name,
          this.#next.get(cloud)!,
        );
  }

  async mintToken(
    subject: TokenSubject,
    audience: string,
    seconds: number,
  ): Promise<string> {
    const core = (await this.#o.kubeConfig()).makeApiClient(CoreV1Api);
    const { status } = await core.createNamespacedServiceAccountToken({
      name: subject === 'api' ? 'anycloud-api' : PROBE.serviceAccount,
      namespace: SYSTEM_RELEASE_NAMESPACE,
      body: { spec: { audiences: [audience], expirationSeconds: seconds } },
    });
    if (!status?.token)
      throw new Error(`TokenRequest for ${subject} returned no token`);
    return status.token;
  }

  /** The cloud's answer; a transient one is asked again twice. */
  async exchange(cloud: RoleCloud, token: string): Promise<ExchangeOutcome> {
    const { trust } = await this.#deployed(cloud);
    return this.#o.wait.for(`${cloud} exchange`, () => trust.exchange(token), {
      timeoutMs: 120_000,
      intervalMs: [5_000, 10_000],
      probeError: { retry: (error) => /transient/u.test(String(error)) },
      unmet: () => undefined,
    });
  }

  async jwksKeyIds(): Promise<readonly string[]> {
    return (await this.#o.issuer()).keyIds;
  }

  rotateSigningKey(step: 'add'): Promise<void>;
  rotateSigningKey(step: 'retire'): Promise<{ readonly refusedEarly: string }>;
  rotateSigningKey(step: 'add' | 'retire') {
    return step === 'add'
      ? this.#lanes.rotateSigningKey(step)
      : this.#lanes.rotateSigningKey(step);
  }

  async outputThrough(
    cloud: RoleCloud,
    connection: string,
    content: string,
  ): Promise<string> {
    const { hosted } = this.#o;
    const where = { credentials: connection, region: this.#o.regions[cloud] };
    // `<ms>-<4>`, as ci/cleanup/e2e-cluster-stale-ids.ts parses: the sweeps reclaim it once stale.
    const bucket = `e2e-clust-out-${String(Date.now())}-${randomUUID().slice(0, 4)}`;
    // Deleted once read: S16 later revokes the connection that signs it.
    const deleteBucket = hosted.bucketDeletion(bucket, where);
    const id = await hosted.checkJob(`role-${cloud}`, {
      image: CHECK_IMAGE,
      command: ['sh', '-c', `echo ${content} > /mnt/output/probe.txt`],
      outputBucket: bucket,
      outputStorage: where,
    });
    const ended = await this.#o.wait.for(
      `role connection ${cloud} Job ${id}`,
      () => hosted.status(id),
      {
        timeoutMs: this.#o.workloadMs,
        intervalMs: 10_000,
        probeError: 'fail',
        unmet: (s) =>
          s !== 'absent' && isTerminalState(s.workload.state)
            ? undefined
            : `state ${s === 'absent' ? 'absent' : s.workload.state}`,
      },
    );
    if (ended === 'absent' || ended.workload.state !== WorkloadState.Completed)
      throw new Error(
        `role connection ${cloud} Job ${id} ended ${ended === 'absent' ? 'absent' : ended.workload.state}: ${await hosted.logs(id)}`,
      );
    const read = await hosted.readBucketObject(
      bucket,
      `${id}/probe.txt`,
      where,
    );
    await deleteBucket();
    return read;
  }

  async record(name: string, value: unknown): Promise<void> {
    await this.#o.artifacts.json(name, value);
  }

  async tokenBucket(cloud: RoleCloud, connection: string) {
    const where = { credentials: connection, region: this.#o.regions[cloud] };
    // `<ms>-<4>`, as ci/cleanup/e2e-cluster-stale-ids.ts parses.
    const bucket = `e2e-clust-tok-${String(Date.now())}-${randomUUID().slice(0, 4)}`;
    const remove = await this.#o.hosted.seedBucket(
      bucket,
      ['out/ref.txt', 'rw/ref.txt'],
      where,
    );
    return { bucket, remove };
  }

  /** The run's API token for the hosted API, which the CLI saved. */
  async #bearer(): Promise<string> {
    const result = await this.#o.cli.run(cliArgs('api token', {}), {
      label: 'hosted-api-token',
      timeoutMs: 120_000,
      recordArtifact: false,
      env: { API_URL: this.#o.hostedUrl() },
    });
    if (result.exitCode !== 0 || result.timedOut)
      throw new Error(`api token failed (exit ${String(result.exitCode)})`);
    return result.stdout.trim();
  }

  async mint(
    connection: string,
    cloud: RoleCloud,
    grants: readonly (StorageTokenGrant & { readonly noDelete: boolean })[],
    lifetimeSeconds: number,
  ): Promise<MintOutcome> {
    const client = createApiClient(await this.#bearer(), {
      apiUrl: this.#o.hostedUrl(),
    });
    try {
      const response = await client.bucket.storageTokens({
        params: { credentialName: connection },
        query: { region: this.#o.regions[cloud] },
        body: { lifetimeSeconds, grants: [...grants] },
      });
      this.#minted = new MintedTokens(response);
      return {
        status: 200,
        tokens: response.tokens.map(({ grants, expiresAt }) => ({
          grants,
          expiresAt,
        })),
      };
    } catch (error) {
      if (!(error instanceof ORPCError)) throw error;
      return { status: error.status, code: String(error.code) };
    }
  }

  #tokens(): MintedTokens {
    if (!this.#minted) throw new Error('no tokens were minted');
    return this.#minted;
  }

  tokenRead(bucket: string, key: string) {
    return this.#tokens().read(bucket, key);
  }

  tokenWrite(bucket: string, key: string) {
    return this.#tokens().write(bucket, key, 1_024);
  }

  tokenRemove(bucket: string, key: string) {
    return this.#tokens().remove(bucket, key);
  }
}

/** Identifier-shaped values for the local API's refusal, which reads none of them. */
const LOCAL_IDENTIFIERS: Readonly<
  Record<RoleCloud, Readonly<Record<string, string>>>
> = {
  aws: { 'role-arn': 'arn:aws:iam::000000000000:role/e2e-local' },
  gcp: {
    'workload-identity-provider':
      'projects/0/locations/global/workloadIdentityPools/e2e-local/providers/e2e-local',
    'service-account-email': 'e2e-local@e2e-local.iam.gserviceaccount.com',
  },
  azure: {
    'application-id': '00000000-0000-0000-0000-000000000000',
    'directory-id': '00000000-0000-0000-0000-000000000000',
    'subscription-id': '00000000-0000-0000-0000-000000000000',
  },
};
