import { CloudType } from '../../../../../src/shared/cloud.js';
import type { ArtifactStore } from '../artifacts.js';
import type { CleanupRegistration, CleanupStack } from '../cleanup.js';
import type { JobNativeAttempt, JobSpotRequest } from '../targets/job-types.js';
import { isRecord } from '../types.js';
import type { Waiter } from '../wait.js';
import type { TrackedWorkloadRef } from '../workloads.js';
import { JobCloudSession } from './job-cloud-session.js';
import { jobOperationTimeout, privateJobJson } from './job-command.js';
import { awsInstanceStates, awsZone } from './public-cloud-vm-host-presence.js';

const REQUEST_ID = /^sir-[a-z0-9]{8,32}$/u;
const INSTANCE_ID = /^i-(?:[a-f0-9]{8}|[a-f0-9]{17})$/u;
const REQUEST_STATES = [
  'open',
  'active',
  'disabled',
  'cancelled',
  'closed',
  'failed',
] as const;
const CANCELLABLE = ['open', 'active', 'disabled'];

interface Dependencies {
  readonly session: JobCloudSession;
  readonly artifacts: Pick<ArtifactStore, 'json'>;
  readonly cleanup: Pick<CleanupStack, 'defer'>;
  readonly cleanupWait: Pick<Waiter, 'for'>;
  readonly id: string;
  readonly credentialId: string;
  readonly ownerApi: string;
  readonly vmTypes: readonly string[];
  readonly cleanupMs: number;
  readonly assertController: () => void;
  readonly nativeAbsent: () => boolean;
}

interface SpotInstance {
  readonly id: string;
  readonly region: string;
  readonly requestId: string;
  readonly state: string;
  readonly launchedAt?: number;
  readonly availabilityZone: string;
}

/** Persistent requests can replace a terminated VM, so rescue cancels before the kernel's delete. */
export class JobSpotTransport {
  readonly #d: Dependencies;
  readonly #requests = new Map<string, JobSpotRequest>();
  readonly #attempts = new Map<string, JobNativeAttempt>();
  readonly #afterCleanup: CleanupRegistration;
  #beforeCleanup?: CleanupRegistration;
  #ref?: TrackedWorkloadRef;
  #capture?: (deadlineAt: number) => Promise<readonly JobNativeAttempt[]>;
  #original?: {
    readonly attempt: JobNativeAttempt;
    readonly request: JobSpotRequest;
  };
  #sent = false;
  #rescued = false;
  #released = false;
  #deadlineAt?: number;
  #observations = 0;

  constructor(dependencies: Dependencies) {
    this.#d = dependencies;
    if (
      dependencies.session.credential.cloudProvider !== CloudType.AWS ||
      !/^[a-f0-9]{64}$/u.test(dependencies.credentialId) ||
      !/^[a-f0-9]{32}$/u.test(dependencies.ownerApi) ||
      !/^[a-z0-9-]{1,48}$/u.test(dependencies.id)
    )
      throw new Error(
        'Job Spot intent lacks its original AWS/controller identity',
      );
    // This registration precedes the kernel's registration. LIFO puts the
    // untracked-replacement rescue after ordinary Workload deletion.
    this.#afterCleanup = dependencies.cleanup.defer(
      `Job ${dependencies.id} persistent Spot requests and replacements`,
      () => this.#rescue(),
    );
  }

  arm(
    ref: TrackedWorkloadRef,
    capture: (deadlineAt: number) => Promise<readonly JobNativeAttempt[]>,
  ): void {
    if (this.#ref || ref.id !== this.#d.id)
      throw new Error('Job Spot intent cannot change its tracked reference');
    this.#ref = ref;
    this.#capture = capture;
    // Registered after the kernel but still before the create send.
    this.#beforeCleanup = this.#d.cleanup.defer(
      `Job ${ref.id} cancel persistent Spot requests before Workload cleanup`,
      async () => {
        if (!this.#sent) return;
        this.#rescued = true;
        await this.#cancelOwned(this.#cleanupDeadline());
      },
    );
  }

  sent(): void {
    this.#scope();
    if (this.#sent) throw new Error('Job Spot submission was repeated');
    this.#sent = true;
  }

  remember(attempts: readonly JobNativeAttempt[]): void {
    this.#scope();
    for (const attempt of attempts) {
      if (
        attempt.ref !== this.#ref ||
        attempt.credentialId !== this.#d.credentialId ||
        attempt.cloudProvider !== CloudType.AWS ||
        !this.#d.vmTypes.includes(attempt.vmType)
      )
        throw new Error(
          'Job Spot history changed its original attempt identity',
        );
      this.#attempts.set(
        JSON.stringify([
          attempt.rowId,
          attempt.createdAt,
          attempt.endedAt,
          attempt.cloudId,
          attempt.region,
          attempt.availabilityZone,
        ]),
        Object.freeze({ ...attempt }),
      );
    }
  }

  async active(
    attempt: JobNativeAttempt,
    deadlineAt: number,
  ): Promise<JobSpotRequest> {
    this.#scope();
    this.remember([attempt]);
    if (
      !this.#sent ||
      attempt.endedAt !== null ||
      !INSTANCE_ID.test(attempt.cloudId)
    )
      throw new Error(
        'Job Spot active evidence requires its live native attempt',
      );
    const requests = await this.#readRequests(
      attempt.region,
      ['--filters', `Name=instance-id,Values=${attempt.cloudId}`],
      deadlineAt,
      false,
    );
    if (requests.length !== 1 || requests[0].instanceId !== attempt.cloudId)
      throw new Error(
        'Job Spot request does not uniquely name the original VM',
      );
    const request = requests[0];
    if (
      this.#original &&
      (this.#original.attempt.rowId !== attempt.rowId ||
        this.#original.attempt.cloudId !== attempt.cloudId ||
        this.#original.request.id !== request.id ||
        this.#original.request.region !== request.region)
    )
      throw new Error('Job Spot active evidence replaced its original request');
    const instances = await this.#readInstances(
      attempt.region,
      ['--instance-ids', attempt.cloudId],
      deadlineAt,
      false,
      { attempt, requestId: request.id },
    );
    if (instances.length !== 1 || instances[0].id !== attempt.cloudId)
      throw new Error(
        'Job Spot active request has no original running instance',
      );
    this.#original ??= { attempt: Object.freeze({ ...attempt }), request };
    return request;
  }

  /**
   * The request a just-launched instance names, read by the instance's
   * ID. The `instance-id` request filter misses for about 30 s after launch.
   */
  async launched(
    attempt: JobNativeAttempt,
    deadlineAt: number,
  ): Promise<{
    readonly request: JobSpotRequest;
    readonly launchedAt: number;
  }> {
    this.#scope();
    this.remember([attempt]);
    if (!this.#sent || this.#original || !INSTANCE_ID.test(attempt.cloudId))
      throw new Error('Job early Spot evidence requires its launched attempt');
    const instances = await this.#readInstances(
      attempt.region,
      ['--instance-ids', attempt.cloudId],
      deadlineAt,
      false,
    );
    const launchedAt = instances[0]?.launchedAt;
    if (
      instances.length !== 1 ||
      instances[0].id !== attempt.cloudId ||
      instances[0].availabilityZone !==
        awsZone(attempt.region, attempt.availabilityZone) ||
      launchedAt === undefined
    )
      throw new Error('Job early Spot instance has no live launch record');
    const requests = await this.#readRequests(
      attempt.region,
      // By ID, as the product reads it: a lagging filter can't miss it.
      ['--spot-instance-request-ids', instances[0].requestId],
      deadlineAt,
      false,
    );
    // AWS may not yet name the instance on its request; the instance names it.
    if (
      requests.length !== 1 ||
      (requests[0].instanceId !== undefined &&
        requests[0].instanceId !== attempt.cloudId)
    )
      throw new Error('Job early Spot request is missing or names another VM');
    const request = Object.freeze({
      ...requests[0],
      instanceId: attempt.cloudId,
    });
    this.#original = { attempt: Object.freeze({ ...attempt }), request };
    return { request, launchedAt };
  }

  async instanceFilter(deadlineAt: number): Promise<readonly JobSpotRequest[]> {
    this.#scope();
    const original = this.#original;
    if (!original) throw new Error('Job Spot has no original request');
    return this.#readRequests(
      original.request.region,
      ['--filters', `Name=instance-id,Values=${original.attempt.cloudId}`],
      deadlineAt,
      false,
    );
  }

  async request(deadlineAt: number): Promise<JobSpotRequest> {
    this.#scope();
    const original = this.#original;
    if (!original) throw new Error('Job Spot has no original active request');
    const requests = await this.#readRequests(
      original.request.region,
      ['--spot-instance-request-ids', original.request.id],
      deadlineAt,
      false,
    );
    if (requests.length !== 1 || requests[0].id !== original.request.id)
      throw new Error('Job Spot original request is missing or changed');
    return requests[0];
  }

  liveInstances(deadlineAt: number): Promise<readonly string[]> {
    this.#scope();
    if (!this.#original)
      throw new Error('Job Spot replacement guard requires active evidence');
    return this.#relatedInstances(deadlineAt, false).then((instances) =>
      instances.map((instance) => instance.id),
    );
  }

  async release(deadlineAt: number): Promise<void> {
    this.#scope();
    if (this.#rescued)
      throw new Error('Spot rescue cannot satisfy automatic cancellation');
    const request = await this.request(deadlineAt);
    if (
      request.state !== 'cancelled' ||
      (request.instanceId !== undefined &&
        request.instanceId !== this.#original?.attempt.cloudId)
    )
      throw new Error(
        'Job did not automatically cancel its original Spot request',
      );
    await this.#assertAbsent(deadlineAt, false);
    if (!this.#d.nativeAbsent())
      throw new Error('Job Spot still owns an unresolved native attempt');
    this.#beforeCleanup!.complete();
    this.#afterCleanup.complete();
    this.#released = true;
  }

  assertAbsent(): void {
    if (!this.#released)
      throw new Error(
        'Job still owns unresolved persistent Spot requests or replacements',
      );
  }

  #scope(): void {
    this.#d.assertController();
    if (this.#released || !this.#ref || !this.#capture)
      throw new Error('Job Spot reference is unarmed or released');
  }

  #regions(): readonly string[] {
    const regions = [
      ...new Set(
        [...this.#attempts.values()].map((a) => a.region).filter(Boolean),
      ),
    ];
    if (
      !regions.length ||
      regions.some((region) => !/^[a-z]{2}-[a-z]+-[1-9]$/u.test(region))
    )
      throw new Error(
        'Job Spot cleanup lacks complete original attempted regions',
      );
    return regions;
  }

  #tags(value: unknown, boundRequest = false): void {
    if (value === undefined && boundRequest) return;
    if (!Array.isArray(value))
      throw new Error('Job Spot ownership tags are missing');
    const tags = new Map<string, string>();
    for (const entry of value) {
      if (
        !isRecord(entry) ||
        typeof entry.Key !== 'string' ||
        typeof entry.Value !== 'string' ||
        tags.has(entry.Key)
      )
        throw new Error('Job Spot ownership tags are incomplete or duplicated');
      tags.set(entry.Key, entry.Value);
    }
    if (
      (tags.get('anycloud_deployment') !== this.#d.id &&
        (!boundRequest || tags.has('anycloud_deployment'))) ||
      (tags.get('anycloud_owner_api') !== this.#d.ownerApi &&
        (!boundRequest || tags.has('anycloud_owner_api')))
    )
      throw new Error(
        'Job Spot native response belongs to another Workload or controller',
      );
  }

  async #record(kind: string, body: unknown, failure?: unknown): Promise<void> {
    try {
      await this.#d.artifacts.json(
        `job-${this.#d.id}-spot-${++this.#observations}`,
        {
          workloadId: this.#d.id,
          generation: 1,
          credentialId: this.#d.credentialId,
          ownerApi: this.#d.ownerApi,
          accountId: this.#d.session.accountId,
          observedAt: Date.now(),
          kind,
          complete: failure === undefined,
          rescued: this.#rescued,
          body,
        },
      );
    } catch (recordError) {
      if (failure !== undefined)
        throw new AggregateError(
          [failure, recordError],
          'Job Spot observation and retention failed',
        );
      throw recordError;
    }
    if (failure !== undefined)
      throw failure instanceof Error
        ? failure
        : new Error('Job Spot observation failed', { cause: failure });
  }

  async #readRequests(
    region: string,
    selection: readonly string[],
    deadlineAt: number,
    cleanup: boolean,
  ): Promise<JobSpotRequest[]> {
    this.#scope();
    const requests: JobSpotRequest[] = [];
    let failure: unknown;
    try {
      const body = privateJobJson(
        await this.#d.session.aws(
          [
            'ec2',
            'describe-spot-instance-requests',
            ...selection,
            '--no-paginate',
          ],
          region,
          deadlineAt,
          cleanup,
        ),
      );
      if (
        !isRecord(body) ||
        !Array.isArray(body.SpotInstanceRequests) ||
        body.NextToken !== undefined ||
        'Error' in body ||
        'Errors' in body
      )
        throw new Error('Job Spot request inventory is incomplete');
      for (const row of body.SpotInstanceRequests) {
        if (
          !isRecord(row) ||
          typeof row.SpotInstanceRequestId !== 'string' ||
          !REQUEST_ID.test(row.SpotInstanceRequestId) ||
          row.Type !== 'persistent' ||
          !REQUEST_STATES.some((state) => state === row.State) ||
          (row.InstanceId !== undefined &&
            (typeof row.InstanceId !== 'string' ||
              !INSTANCE_ID.test(row.InstanceId))) ||
          !isRecord(row.LaunchSpecification) ||
          !this.#d.vmTypes.includes(
            String(row.LaunchSpecification.InstanceType),
          )
        )
          throw new Error(
            'Job Spot request has an invalid identity, state or launch profile',
          );
        this.#tags(row.Tags);
        if (
          requests.some((request) => request.id === row.SpotInstanceRequestId)
        )
          throw new Error('Job Spot inventory repeats a request identity');
        const status = isRecord(row.Status) ? row.Status : {};
        const updatedAt = Date.parse(String(status.UpdateTime));
        const request: JobSpotRequest = Object.freeze({
          id: row.SpotInstanceRequestId,
          region,
          instanceId: row.InstanceId,
          ...(typeof status.Code === 'string' && { statusCode: status.Code }),
          ...(Number.isFinite(updatedAt) && { updatedAt }),
          type: 'persistent',
          state: row.State as JobSpotRequest['state'],
        });
        requests.push(request);
        this.#requests.set(`${region}/${request.id}`, request);
      }
      this.#scope();
    } catch (error) {
      failure = error;
    }
    await this.#record(
      'request-inventory',
      { region, selection, requests },
      failure,
    );
    return requests;
  }

  async #readInstances(
    region: string,
    selection: readonly string[],
    deadlineAt: number,
    cleanup: boolean,
    active?: { readonly attempt: JobNativeAttempt; readonly requestId: string },
    boundRequestId?: string,
  ): Promise<SpotInstance[]> {
    this.#scope();
    const live: SpotInstance[] = [];
    const observed: { id: string; state: string; requestId: string }[] = [];
    let failure: unknown;
    try {
      const body = privateJobJson(
        await this.#d.session.aws(
          ['ec2', 'describe-instances', ...selection, '--no-paginate'],
          region,
          deadlineAt,
          cleanup,
        ),
      );
      if (
        !isRecord(body) ||
        !Array.isArray(body.Reservations) ||
        body.NextToken !== undefined ||
        'Error' in body ||
        'Errors' in body
      )
        throw new Error('Job Spot instance inventory is incomplete');
      for (const reservation of body.Reservations) {
        if (
          !isRecord(reservation) ||
          reservation.OwnerId !== this.#d.session.accountId ||
          !Array.isArray(reservation.Instances)
        )
          throw new Error(
            'Job Spot instance inventory changed its original AWS account',
          );
        for (const vm of reservation.Instances) {
          if (
            !isRecord(vm) ||
            typeof vm.InstanceId !== 'string' ||
            !INSTANCE_ID.test(vm.InstanceId) ||
            !isRecord(vm.Placement) ||
            typeof vm.Placement.AvailabilityZone !== 'string' ||
            awsZone(region, vm.Placement.AvailabilityZone) !==
              vm.Placement.AvailabilityZone ||
            !this.#d.vmTypes.includes(String(vm.InstanceType)) ||
            typeof vm.SpotInstanceRequestId !== 'string' ||
            !REQUEST_ID.test(vm.SpotInstanceRequestId)
          )
            throw new Error(
              'Job Spot instance changed its placement or request identity',
            );
          if (
            boundRequestId &&
            (vm.SpotInstanceRequestId !== boundRequestId ||
              !this.#requests.has(`${region}/${boundRequestId}`))
          )
            throw new Error(
              'Job Spot replacement does not belong to its bound request',
            );
          this.#tags(vm.Tags, boundRequestId !== undefined);
          const states = awsInstanceStates(
            { Reservations: [{ ...reservation, Instances: [vm] }] },
            vm.InstanceId,
            {
              region,
              availabilityZone: active?.attempt.availabilityZone ?? null,
            },
          );
          if (observed.some((entry) => entry.id === vm.InstanceId))
            throw new Error('Job Spot inventory repeats an instance identity');
          if (
            active &&
            (vm.InstanceId !== active.attempt.cloudId ||
              vm.SpotInstanceRequestId !== active.requestId ||
              states[0] !== 'running')
          )
            throw new Error(
              'Job Spot active inventory changed its original VM',
            );
          observed.push({
            id: vm.InstanceId,
            state: states[0],
            requestId: vm.SpotInstanceRequestId,
          });
          const launchedAt = Date.parse(String(vm.LaunchTime));
          if (states[0] !== 'terminated')
            live.push({
              id: vm.InstanceId,
              region,
              state: states[0],
              requestId: vm.SpotInstanceRequestId,
              availabilityZone: vm.Placement.AvailabilityZone,
              ...(Number.isFinite(launchedAt) && { launchedAt }),
            });
        }
      }
      this.#scope();
    } catch (error) {
      failure = error;
    }
    await this.#record(
      'instance-inventory',
      { region, selection, observed },
      failure,
    );
    return live;
  }

  #workloadFilters(): string[] {
    return [
      `Name=tag:anycloud_deployment,Values=${this.#d.id}`,
      `Name=tag:anycloud_owner_api,Values=${this.#d.ownerApi}`,
    ];
  }

  async #relatedInstances(
    deadlineAt: number,
    cleanup: boolean,
  ): Promise<SpotInstance[]> {
    const live = new Map<string, SpotInstance>();
    for (const region of this.#regions()) {
      for (const instance of await this.#readInstances(
        region,
        ['--filters', ...this.#workloadFilters()],
        deadlineAt,
        cleanup,
      ))
        live.set(`${region}/${instance.id}`, instance);
      for (const request of this.#requests.values()) {
        if (request.region !== region) continue;
        for (const instance of await this.#readInstances(
          region,
          ['--filters', `Name=spot-instance-request-id,Values=${request.id}`],
          deadlineAt,
          cleanup,
          undefined,
          request.id,
        ))
          live.set(`${region}/${instance.id}`, instance);
      }
    }
    return [...live.values()];
  }

  async #currentRequests(
    region: string,
    deadlineAt: number,
    cleanup: boolean,
  ): Promise<JobSpotRequest[]> {
    const tagged = await this.#readRequests(
      region,
      ['--filters', ...this.#workloadFilters()],
      deadlineAt,
      cleanup,
    );
    const current: JobSpotRequest[] = [];
    // A tag-filtered empty list cannot erase an already bound request. Read
    // every known ID independently; changed tags or contradictory reads fail.
    for (const known of this.#requests.values()) {
      if (known.region !== region) continue;
      const exact = await this.#readRequests(
        region,
        ['--filters', `Name=spot-instance-request-id,Values=${known.id}`],
        deadlineAt,
        cleanup,
      );
      if (
        exact.length > 1 ||
        exact.some((request) => request.id !== known.id) ||
        (exact.length === 0 &&
          tagged.some((request) => request.id === known.id))
      )
        throw new Error(
          'Job Spot exact and tagged request inventories disagree',
        );
      current.push(...exact);
    }
    return current;
  }

  #cleanupDeadline(): number {
    this.#deadlineAt ??= Date.now() + this.#d.cleanupMs;
    return this.#deadlineAt;
  }

  async #cancelOwned(deadlineAt: number): Promise<void> {
    this.#scope();
    const errors: unknown[] = [];
    if (!this.#d.nativeAbsent()) {
      try {
        this.remember(await this.#capture!(deadlineAt));
      } catch (error) {
        errors.push(error);
      }
    }
    let regions: readonly string[] = [];
    try {
      regions = this.#regions();
    } catch (error) {
      errors.push(error);
    }
    for (const region of regions) {
      let current: readonly JobSpotRequest[] = [];
      try {
        current = await this.#currentRequests(region, deadlineAt, true);
      } catch (error) {
        errors.push(error);
      }
      for (const request of current) {
        if (!CANCELLABLE.includes(request.state)) continue;
        try {
          const body = privateJobJson(
            await this.#d.session.aws(
              [
                'ec2',
                'cancel-spot-instance-requests',
                '--spot-instance-request-ids',
                request.id,
              ],
              region,
              deadlineAt,
              true,
            ),
          );
          if (
            !isRecord(body) ||
            !Array.isArray(body.CancelledSpotInstanceRequests) ||
            body.CancelledSpotInstanceRequests.length !== 1 ||
            !isRecord(body.CancelledSpotInstanceRequests[0]) ||
            body.CancelledSpotInstanceRequests[0].SpotInstanceRequestId !==
              request.id ||
            body.CancelledSpotInstanceRequests[0].State !== 'cancelled'
          )
            throw new Error(
              'Job Spot cancellation returned a foreign or incomplete acknowledgement',
            );
          await this.#record('rescue-cancel', {
            region,
            requestId: request.id,
          });
        } catch (error) {
          errors.push(error);
        }
      }
    }
    await this.#record(
      'rescue-cancellation-result',
      { regions, attempts: [...this.#attempts.values()] },
      errors.length
        ? new AggregateError(errors, 'Job Spot cancellation or history failed')
        : undefined,
    );
  }

  async #assertAbsent(deadlineAt: number, cleanup: boolean): Promise<void> {
    for (const region of this.#regions()) {
      const requests = await this.#currentRequests(region, deadlineAt, cleanup);
      if (requests.some((request) => CANCELLABLE.includes(request.state)))
        throw new Error('Job still owns an active persistent Spot request');
    }
    if ((await this.#relatedInstances(deadlineAt, cleanup)).length)
      throw new Error(
        'Job still owns a live Spot instance or untracked replacement',
      );
  }

  async #rescue(): Promise<void> {
    if (!this.#sent) {
      this.#released = true;
      return;
    }
    this.#rescued = true;
    const deadlineAt = this.#cleanupDeadline();
    const errors: unknown[] = [];
    try {
      await this.#cancelOwned(deadlineAt);
    } catch (error) {
      errors.push(error);
    }
    let regions: readonly string[] = [];
    try {
      regions = this.#regions();
    } catch (error) {
      errors.push(error);
    }
    for (const region of regions) {
      try {
        const current = await this.#currentRequests(region, deadlineAt, true);
        if (current.some((request) => CANCELLABLE.includes(request.state)))
          throw new Error(
            'Job Spot rescue cannot terminate before cancellation is independently observed',
          );
        const live = new Map(
          (
            await this.#readInstances(
              region,
              ['--filters', ...this.#workloadFilters()],
              deadlineAt,
              true,
            )
          ).map((instance) => [instance.id, instance]),
        );
        for (const request of this.#requests.values()) {
          if (request.region !== region) continue;
          for (const instance of await this.#readInstances(
            region,
            ['--filters', `Name=spot-instance-request-id,Values=${request.id}`],
            deadlineAt,
            true,
            undefined,
            request.id,
          ))
            live.set(instance.id, instance);
        }
        for (const { id, requestId } of live.values()) {
          if (
            !current.some(
              (request) =>
                request.id === requestId &&
                !CANCELLABLE.includes(request.state),
            )
          )
            throw new Error(
              'Job Spot replacement has no independently inactive owned request',
            );
          const body = privateJobJson(
            await this.#d.session.aws(
              ['ec2', 'terminate-instances', '--instance-ids', id],
              region,
              deadlineAt,
              true,
            ),
          );
          if (
            !isRecord(body) ||
            !Array.isArray(body.TerminatingInstances) ||
            body.TerminatingInstances.length !== 1 ||
            !isRecord(body.TerminatingInstances[0]) ||
            body.TerminatingInstances[0].InstanceId !== id ||
            !isRecord(body.TerminatingInstances[0].CurrentState) ||
            !['shutting-down', 'terminated'].includes(
              String(body.TerminatingInstances[0].CurrentState.Name),
            )
          )
            throw new Error(
              'Job Spot rescue returned a foreign or incomplete termination acknowledgement',
            );
          await this.#record('rescue-terminate', { region, instanceId: id });
        }
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      const remaining = jobOperationTimeout(deadlineAt, this.#d.cleanupMs);
      await this.#d.cleanupWait.for(
        'Job Spot requests and replacements absent',
        async (deadline) => {
          const requests = [];
          const bounded = Math.min(deadline, deadlineAt);
          for (const region of this.#regions())
            requests.push(
              ...(await this.#currentRequests(region, bounded, true)),
            );
          return {
            requests,
            live: await this.#relatedInstances(bounded, true),
          };
        },
        {
          timeoutMs: remaining,
          intervalMs: Math.min(5_000, remaining),
          probeError: 'fail',
          unmet: ({ requests, live }) =>
            requests.some((request) => CANCELLABLE.includes(request.state)) ||
            live.length
              ? 'owned request or replacement remains'
              : undefined,
        },
      );
      if (!this.#d.nativeAbsent())
        throw new Error('Job Spot still owns an unresolved native attempt');
    } catch (error) {
      errors.push(error);
    }
    await this.#record(
      'rescue-result',
      { regions, attempts: [...this.#attempts.values()] },
      errors.length
        ? new AggregateError(
            errors,
            'Job Spot rescue retained unresolved cleanup',
          )
        : undefined,
    );
    this.#released = true;
  }
}
