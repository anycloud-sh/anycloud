import { CloudType } from '../../../../../src/shared/cloud.js';
import type { JobStorageProvider } from '../targets/job-types.js';
import { isRecord } from '../types.js';
import { rethrowLastAttempt, WaitTimeoutError } from '../wait.js';
import {
  JobCloudSession,
  JobNativeReadIncomplete,
} from './job-cloud-session.js';
import { JobPrivateCommandFailure, privateJobJson } from './job-command.js';

export interface JobBucketIdentity {
  readonly provider: JobStorageProvider;
  readonly scope: string;
  readonly nativeId: string;
  readonly name: string;
  readonly region: string;
  readonly createdAt: number;
  readonly ownerApi: string;
  readonly ownerUser: string;
  readonly workloadId: string;
}

export type JobNativeBucketObservation =
  | {
      readonly presence: 'absent';
      readonly name: string;
      readonly scope: string;
    }
  | { readonly presence: 'present'; readonly identity: JobBucketIdentity };

function ownership(
  value: unknown,
): Pick<
  JobBucketIdentity,
  'createdAt' | 'ownerApi' | 'ownerUser' | 'workloadId'
> {
  if (
    !isRecord(value) ||
    typeof value.anycloud_created_at !== 'string' ||
    !/^[1-9][0-9]*$/u.test(value.anycloud_created_at) ||
    !Number.isSafeInteger(Number(value.anycloud_created_at)) ||
    typeof value.anycloud_owner_api !== 'string' ||
    !/^[a-f0-9]{32}$/u.test(value.anycloud_owner_api) ||
    typeof value.anycloud_user !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,64}$/u.test(value.anycloud_user) ||
    typeof value.anycloud_deployment !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,128}$/u.test(value.anycloud_deployment)
  )
    throw new Error(
      'Job native bucket ownership metadata is missing or malformed',
    );
  return {
    createdAt: Number(value.anycloud_created_at),
    ownerApi: value.anycloud_owner_api,
    ownerUser: value.anycloud_user,
    workloadId: value.anycloud_deployment,
  };
}

/** Native reads keep original account/project/container scope; empty objects are never bucket absence. */
export class JobBucketNativeReader {
  readonly #session: JobCloudSession;
  readonly #region: string;
  // The validated shared-account readback, read once per run.
  #azureAccount:
    | { readonly status: number; readonly body: unknown }
    | undefined;
  constructor(session: JobCloudSession, region: string) {
    if (!/^[a-z][a-z0-9-]{1,63}$/u.test(region))
      throw new Error('Job bucket region is malformed');
    this.#session = session;
    this.#region = region;
  }

  initialize(deadlineAt: number): Promise<void> {
    return this.#session.initialize(deadlineAt);
  }

  async observe(
    name: string,
    deadlineAt: number,
    cleanup = false,
    followsCompute = false,
  ): Promise<JobNativeBucketObservation> {
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u.test(name))
      throw new Error('Job bucket name is malformed');
    switch (this.#session.credential.cloudProvider) {
      case CloudType.AWS:
        return this.#aws(name, deadlineAt, cleanup, followsCompute);
      case CloudType.GCP:
        return this.#gcp(name, deadlineAt, cleanup, followsCompute);
      case CloudType.Azure:
        return this.#azure(name, deadlineAt, cleanup);
    }
  }

  /** Preserve the GCS input fixture's explicit bootstrap object-reader grant. */
  async prepareInput(name: string, deadlineAt: number): Promise<void> {
    const credential = this.#session.credential;
    if (credential.cloudProvider === CloudType.GCP) {
      const failures: unknown[] = [];
      await this.#session
        .waitFor(
          'Job GCS input reader grant',
          () => this.#gcpReaderGrant(name, credential.clientEmail, deadlineAt),
          {
            intervalMs: [2_000, 2_000],
            // Every error is retried; the policy also collects it for the AggregateError.
            probeError: { retry: (error) => failures.push(error) > 0 },
            unmet: () => undefined,
          },
          deadlineAt,
        )
        .catch((error: unknown) => {
          if (!(error instanceof WaitTimeoutError)) throw error;
          throw new AggregateError(
            failures,
            'Job GCS input reader grant failed its three bounded attempts',
          );
        });
    }
  }

  async #gcpReaderGrant(
    name: string,
    clientEmail: string,
    deadlineAt: number,
  ): Promise<void> {
    await this.#session.gcp(
      [
        'storage',
        'buckets',
        'add-iam-policy-binding',
        `gs://${name}`,
        `--member=serviceAccount:${clientEmail}`,
        '--role=roles/storage.objectViewer',
        '--format=json',
      ],
      deadlineAt,
    );
    const policy = privateJobJson(
      await this.#session.gcp(
        [
          'storage',
          'buckets',
          'get-iam-policy',
          `gs://${name}`,
          '--format=json',
        ],
        deadlineAt,
      ),
    );
    if (
      !isRecord(policy) ||
      !Array.isArray(policy.bindings) ||
      !policy.bindings.some(
        (binding: unknown) =>
          isRecord(binding) &&
          binding.role === 'roles/storage.objectViewer' &&
          Array.isArray(binding.members) &&
          binding.members.includes(`serviceAccount:${clientEmail}`),
      )
    )
      throw new Error('Job GCS input bucket lacks its bootstrap reader grant');
  }

  async #aws(
    name: string,
    deadlineAt: number,
    cleanup: boolean,
    followsCompute: boolean,
  ): Promise<JobNativeBucketObservation> {
    const scope = this.#session.accountId;
    const bucket = ['--bucket', name, '--expected-bucket-owner', scope];
    let location: unknown;
    try {
      location = privateJobJson(
        await this.#session.aws(
          ['s3api', 'get-bucket-location', ...bucket],
          this.#region,
          deadlineAt,
          cleanup,
        ),
      );
    } catch (error) {
      // A generic HeadBucket 404 cannot distinguish missing buckets from rejected
      // authorization. Only the exact bucket's complete named native error does.
      if (
        error instanceof JobPrivateCommandFailure &&
        error.nativeCode === 'NoSuchBucket'
      )
        return { presence: 'absent', name, scope };
      throw error;
    }
    const region = isRecord(location)
      ? location.LocationConstraint === null
        ? 'us-east-1'
        : location.LocationConstraint
      : undefined;
    if (
      typeof region !== 'string' ||
      !/^[a-z]{2}-[a-z]+-[1-9]$/u.test(region) ||
      (!followsCompute && region !== this.#region)
    )
      throw new Error('Job S3 bucket changed its original region');
    const tags = privateJobJson(
      await this.#session.aws(
        ['s3api', 'get-bucket-tagging', ...bucket],
        region,
        deadlineAt,
        cleanup,
      ),
    );
    if (!isRecord(tags) || !Array.isArray(tags.TagSet))
      throw new Error('Job S3 tag inventory is malformed');
    const metadata: Record<string, string> = {};
    for (const tag of tags.TagSet) {
      if (
        !isRecord(tag) ||
        typeof tag.Key !== 'string' ||
        typeof tag.Value !== 'string' ||
        Object.hasOwn(metadata, tag.Key)
      )
        throw new Error('Job S3 tag inventory is malformed or repeated');
      metadata[tag.Key] = tag.Value;
    }
    return {
      presence: 'present',
      identity: Object.freeze({
        provider: 'aws',
        scope,
        nativeId: `arn:aws:s3:::${name}`,
        name,
        region,
        ...ownership(metadata),
      }),
    };
  }

  async #gcp(
    name: string,
    deadlineAt: number,
    cleanup: boolean,
    followsCompute: boolean,
  ): Promise<JobNativeBucketObservation> {
    const credential = this.#session.credential;
    if (credential.cloudProvider !== CloudType.GCP)
      throw new Error('Job GCS reader has another authorization');
    const scope = `${credential.projectId}/${this.#session.projectNumber}`;
    const { status, body } = await this.#session.get(
      new URL(
        `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(name)}`,
      ),
      deadlineAt,
      cleanup,
    );
    if (
      status === 404 &&
      isRecord(body) &&
      isRecord(body.error) &&
      body.error.code === 404 &&
      Array.isArray(body.error.errors) &&
      body.error.errors.length > 0 &&
      body.error.errors.every(
        (error: unknown) =>
          isRecord(error) &&
          error.reason === 'notFound' &&
          error.domain === 'global',
      )
    )
      return { presence: 'absent', name, scope };
    if (
      status !== 200 ||
      !isRecord(body) ||
      body.kind !== 'storage#bucket' ||
      body.name !== name ||
      body.id !== name ||
      body.projectNumber !== this.#session.projectNumber ||
      typeof body.location !== 'string' ||
      (!followsCompute && body.location.toLowerCase() !== this.#region) ||
      !/^[a-z0-9-]+$/u.test(body.location.toLowerCase()) ||
      !isRecord(body.iamConfiguration) ||
      !isRecord(body.iamConfiguration.uniformBucketLevelAccess) ||
      body.iamConfiguration.uniformBucketLevelAccess.enabled !== true ||
      typeof body.timeCreated !== 'string' ||
      !Number.isFinite(Date.parse(body.timeCreated))
    )
      throw new Error(
        'Job GCS bucket identity, location or uniform access is invalid',
      );
    return {
      presence: 'present',
      identity: Object.freeze({
        provider: 'gcp',
        scope,
        nativeId: `projects/_/buckets/${name}@${body.timeCreated}`,
        name,
        region: body.location.toLowerCase(),
        ...ownership(body.labels),
      }),
    };
  }

  async #azure(
    name: string,
    deadlineAt: number,
    cleanup: boolean,
  ): Promise<JobNativeBucketObservation> {
    // Product creation can land between a 404 GET and the inventory that must
    // corroborate it (run 37745156990), so re-read the pair while it disagrees.
    // Cleanup's inner re-list already runs to the deadline, ending this at once.
    const observed = await this.#reread(
      () => this.#azureObservation(name, deadlineAt, cleanup),
      (value) => value === 'listed',
      deadlineAt,
      cleanup,
    );
    if (observed === 'listed')
      throw new Error(
        'Job Azure container absence contradicts its native inventory',
      );
    return observed;
  }

  /** `listed`: a 404 GET whose inventory still names the target. */
  async #azureObservation(
    name: string,
    deadlineAt: number,
    cleanup: boolean,
  ): Promise<JobNativeBucketObservation | 'listed'> {
    const credential = this.#session.credential;
    if (credential.cloudProvider !== CloudType.Azure)
      throw new Error('Job Azure bucket reader has another authorization');
    const account = `anycloud${credential.subscriptionId.replaceAll('-', '').slice(0, 8)}`;
    const accountId = `/subscriptions/${credential.subscriptionId}/resourceGroups/anycloud-storage/providers/Microsoft.Storage/storageAccounts/${account}`;
    const nativeId = `${accountId}/blobServices/default/containers/${name}`;
    const accountUrl = new URL(
      `https://management.azure.com${accountId}?api-version=2025-06-01`,
    );
    const accountRead =
      this.#azureAccount ??
      (await this.#azureRetriedRead(accountUrl, deadlineAt, cleanup));
    if (
      accountRead.status === 404 &&
      isRecord(accountRead.body) &&
      isRecord(accountRead.body.error) &&
      ['ResourceNotFound', 'ResourceGroupNotFound'].includes(
        String(accountRead.body.error.code),
      )
    ) {
      // Product bucket creation owns lazy initialization of this shared parent.
      // An authorized subscription inventory must corroborate the parent 404.
      if (
        await this.#azureInventoryNames(
          `/subscriptions/${credential.subscriptionId}/providers/Microsoft.Storage/storageAccounts`,
          accountId,
          account,
          'account',
          deadlineAt,
          cleanup,
        )
      )
        return 'listed';
      return { presence: 'absent', name, scope: accountId.toLowerCase() };
    }
    if (
      accountRead.status !== 200 ||
      !isRecord(accountRead.body) ||
      typeof accountRead.body.id !== 'string' ||
      accountRead.body.id.toLowerCase() !== accountId.toLowerCase() ||
      typeof accountRead.body.location !== 'string' ||
      !/^[a-z0-9]+$/u.test(accountRead.body.location.toLowerCase())
    ) {
      const code =
        isRecord(accountRead.body) && isRecord(accountRead.body.error)
          ? `, ${String(accountRead.body.error.code).slice(0, 80)}`
          : '';
      throw new Error(
        `Job Azure container has no exact original storage-account readback (HTTP ${accountRead.status}${code})`,
      );
    }
    this.#azureAccount = accountRead;
    // Run 39996464316: one transient container GET failed a member.
    const { status, body } = await this.#azureRetriedRead(
      new URL(`https://management.azure.com${nativeId}?api-version=2025-06-01`),
      deadlineAt,
      cleanup,
    );
    if (
      status === 404 &&
      isRecord(body) &&
      isRecord(body.error) &&
      ['ContainerNotFound', 'ResourceNotFound'].includes(
        String(body.error.code),
      )
    ) {
      // ARM's generic 404 is not an absence witness. Require the original
      // account and a complete, unfiltered native container inventory as well.
      if (
        await this.#azureInventoryNames(
          `${accountId}/blobServices/default/containers`,
          nativeId,
          name,
          'container',
          deadlineAt,
          cleanup,
        )
      )
        return 'listed';
      return { presence: 'absent', name, scope: accountId.toLowerCase() };
    }
    if (
      status !== 200 ||
      !isRecord(body) ||
      typeof body.id !== 'string' ||
      body.id.toLowerCase() !== nativeId.toLowerCase() ||
      body.name !== name ||
      typeof body.type !== 'string' ||
      body.type.toLowerCase() !==
        'microsoft.storage/storageaccounts/blobservices/containers' ||
      !isRecord(body.properties)
    ) {
      const code =
        isRecord(body) && isRecord(body.error)
          ? `, ${String(body.error.code).slice(0, 80)}`
          : '';
      throw new Error(
        `Job Azure container readback is missing, foreign or malformed (HTTP ${status}${code})`,
      );
    }
    // Azure reuses the subscription's shared account across compute regions.
    return {
      presence: 'present',
      identity: Object.freeze({
        provider: 'azure',
        scope: accountId.toLowerCase(),
        nativeId: nativeId.toLowerCase(),
        name,
        region: accountRead.body.location.toLowerCase(),
        ...ownership(body.properties.metadata),
      }),
    };
  }

  /**
   * Whether the inventory names the target. ARM inventories lag deletion, so
   * cleanup re-lists one that still does; a run observation re-reads the GET.
   */
  #azureInventoryNames(
    pathname: string,
    nativeId: string,
    name: string,
    kind: 'account' | 'container',
    deadlineAt: number,
    cleanup: boolean,
  ): Promise<boolean> {
    const lists = () =>
      this.#azureInventoryLists(
        pathname,
        nativeId,
        name,
        kind,
        deadlineAt,
        cleanup,
      );
    return cleanup
      ? this.#reread(lists, (listed) => listed, deadlineAt, cleanup)
      : lists();
  }

  async #azureInventoryLists(
    pathname: string,
    nativeId: string,
    name: string,
    kind: 'account' | 'container',
    deadlineAt: number,
    cleanup: boolean,
  ): Promise<boolean> {
    let url = new URL(
      `https://management.azure.com${pathname}?api-version=2025-06-01`,
    );
    const pages = new Set<string>();
    const names = new Set<string>();
    for (;;) {
      if (
        url.origin !== 'https://management.azure.com' ||
        url.username ||
        url.password ||
        url.hash ||
        url.pathname.toLowerCase() !== pathname.toLowerCase() ||
        url.searchParams.get('api-version') !== '2025-06-01' ||
        [...url.searchParams.keys()].some(
          (key) =>
            !['api-version', '$skipToken', '$maxpagesize'].includes(key) ||
            url.searchParams.getAll(key).length !== 1,
        ) ||
        pages.has(url.href) ||
        pages.size >= 100
      )
        throw new Error(
          'Job Azure container inventory changed scope or repeated a page',
        );
      pages.add(url.href);
      const { status, body } = await this.#azureGet(url, deadlineAt, cleanup);
      if (status !== 200 || !isRecord(body) || !Array.isArray(body.value))
        throw new Error(
          'Job Azure container inventory is unavailable or malformed',
        );
      for (const row of body.value as unknown[]) {
        if (
          !isRecord(row) ||
          typeof row.name !== 'string' ||
          !(
            kind === 'account'
              ? /^[a-z0-9]{3,24}$/u
              : /^(?:\$(?:root|web|logs)|[a-z0-9][a-z0-9-]{1,61}[a-z0-9])$/u
          ).test(row.name) ||
          typeof row.id !== 'string' ||
          !(kind === 'account'
            ? new RegExp(
                `^${pathname.split('/providers/')[0]}/resourceGroups/[^/]+/providers/Microsoft\\.Storage/storageAccounts/${row.name}$`,
                'iu',
              ).test(row.id)
            : row.id.toLowerCase() ===
              `${pathname}/${row.name}`.toLowerCase()) ||
          typeof row.type !== 'string' ||
          row.type.toLowerCase() !==
            (kind === 'account'
              ? 'microsoft.storage/storageaccounts'
              : 'microsoft.storage/storageaccounts/blobservices/containers') ||
          (kind === 'container' && !isRecord(row.properties)) ||
          names.has(row.name)
        )
          throw new Error(
            'Job Azure container inventory is malformed, repeated or foreign',
          );
        names.add(row.name);
        if (
          row.name === name ||
          row.id.toLowerCase() === nativeId.toLowerCase()
        )
          return true;
      }
      if (
        body.nextLink === undefined ||
        body.nextLink === null ||
        body.nextLink === ''
      )
        return false;
      if (typeof body.nextLink !== 'string')
        throw new Error(
          'Job Azure container inventory continuation is malformed',
        );
      url = new URL(body.nextLink);
    }
  }

  /** Re-read while `lagging` holds and a whole two-second pause still fits. */
  #reread<T>(
    read: () => Promise<T>,
    lagging: (value: T) => boolean,
    deadlineAt: number,
    cleanup: boolean,
  ): Promise<T> {
    return this.#session.waitFor(
      'Job Azure re-read',
      read,
      {
        probeError: 'fail',
        unmet: (value) =>
          lagging(value) && Date.now() + 2_000 < deadlineAt
            ? 'answer still lagging'
            : undefined,
      },
      deadlineAt,
      cleanup,
    );
  }

  /**
   * ARM throttling and server faults are transient; every other answer is
   * final. A 429 waits its `Retry-After`, since the Storage resource provider's
   * window is shared across the subscription.
   */
  #azureRetriedRead(
    url: URL,
    deadlineAt: number,
    cleanup: boolean,
  ): Promise<{ readonly status: number; readonly body: unknown }> {
    let throttledMs = 0;
    return this.#reread(
      async () => {
        // The re-read itself pauses two seconds; pause the rest of the wait.
        if (throttledMs > 2_000)
          await this.#session.pause(throttledMs - 2_000, deadlineAt, cleanup);
        const read = await this.#azureGet(url, deadlineAt, cleanup);
        throttledMs = read.status === 429 ? (read.retryAfterMs ?? 0) : 0;
        return read;
      },
      (read) =>
        (read.status === 429 || read.status >= 500) &&
        Date.now() + Math.max(2_000, throttledMs) < deadlineAt,
      deadlineAt,
      cleanup,
    );
  }

  /** Retry only an incomplete ARM read; any completed response is judged by the caller. */
  #azureGet(
    url: URL,
    deadlineAt: number,
    cleanup: boolean,
  ): Promise<{
    readonly status: number;
    readonly body: unknown;
    readonly retryAfterMs?: number;
  }> {
    return this.#session
      .waitFor(
        'Job Azure read',
        () => this.#session.get(url, deadlineAt, cleanup),
        {
          intervalMs: [2_000, 2_000],
          probeError: {
            retry: (error) => error instanceof JobNativeReadIncomplete,
          },
          unmet: () => undefined,
        },
        deadlineAt,
        cleanup,
      )
      .catch(rethrowLastAttempt);
  }
}
