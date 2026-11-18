import { afterEach, describe, expect, it, vi } from 'vitest';
import { CandidatePreflightCache } from '../../../src/api/services/candidate-preflight-cache';
import {
  CandidateEligibilityExhaustedError,
  CandidateRegionAvailability,
  candidateRegionKey,
  canFilterCandidateRegions,
  createCandidateRegionFilter,
  exactCandidatePairsKey,
  type CandidateRegionFilterOps,
  type CandidateRegionFilterOptions,
  type CandidateRegionSnapshotInput,
  type CandidateRegion,
} from '../../../src/api/services/gateways/cloud';
import { makeMockCloudCompute } from '../helpers/fixtures';

vi.mock('../../../src/api/services/logger', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

interface TestSnapshot {
  availability: Map<string, CandidateRegionAvailability>;
  complete: boolean;
}

type SnapshotFetch = (
  input: CandidateRegionSnapshotInput,
) => Promise<TestSnapshot>;

function makeSnapshotGateway(
  fetchSnapshot: SnapshotFetch,
  options: {
    scope?: string;
    cache?: CandidatePreflightCache<TestSnapshot>;
    assess?: CandidateRegionFilterOps<TestSnapshot>['assess'];
    assessLocalEligibility?: CandidateRegionFilterOps<TestSnapshot>['assessLocalEligibility'];
    providesLiveCapacitySignal?: boolean;
  } = {},
) {
  const cache = options.cache ?? new CandidatePreflightCache<TestSnapshot>();
  const candidateRegionFilter = createCandidateRegionFilter({
    providesLiveCapacitySignal: options.providesLiveCapacitySignal,
    cache,
    cacheKey: ({ candidates, spot }) =>
      JSON.stringify([
        options.scope ?? 'test-scope',
        spot,
        exactCandidatePairsKey(candidates),
      ]),
    assessLocalEligibility: options.assessLocalEligibility,
    runPreflight: fetchSnapshot,
    isComplete: (snapshot) => snapshot.complete,
    assess:
      options.assess ??
      ((snapshot, candidate) =>
        snapshot.availability.get(candidateRegionKey(candidate))),
  });
  const gateway = makeMockCloudCompute({}, { candidateRegionFilter });
  if (!canFilterCandidateRegions(gateway)) {
    throw new Error('expected candidate availability capability');
  }
  return gateway;
}

function filterCandidatesByAvailability(
  gateway: ReturnType<typeof makeSnapshotGateway>,
  candidates: CandidateRegion[],
  options: CandidateRegionFilterOptions & {
    spot: boolean;
    workloadId: string;
  },
) {
  return gateway.filterCandidateRegions(
    candidates,
    options.spot,
    options.workloadId,
    options,
  );
}

describe('snapshot-backed candidate region filter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fetches exact deduplicated pairs and centrally applies tri-state policy', async () => {
    const first = { vmType: 'a', region: 'r1' };
    const second = { vmType: 'b', region: 'r2' };
    const missing = { vmType: 'c', region: 'r3' };
    const fetchSnapshot = vi.fn(
      async ({
        candidates,
      }: CandidateRegionSnapshotInput): Promise<TestSnapshot> => ({
        availability: new Map([
          [
            candidateRegionKey(candidates[0]!),
            CandidateRegionAvailability.Unavailable,
          ],
          [
            candidateRegionKey(candidates[1]!),
            CandidateRegionAvailability.Verified,
          ],
          // Omitting the third result must become Unknown, never Unavailable.
        ]),
        complete: false,
      }),
    );
    const gateway = makeSnapshotGateway(fetchSnapshot);

    await expect(
      filterCandidatesByAvailability(gateway, [first, second, first, missing], {
        spot: false,
        workloadId: 'exact-pairs',
      }),
    ).resolves.toEqual([second, missing]);

    expect(fetchSnapshot).toHaveBeenCalledOnce();
    expect(fetchSnapshot.mock.calls[0]![0].candidates).toEqual([
      first,
      second,
      missing,
    ]);
  });

  it('does not claim a live capacity signal unless the provider opts in', async () => {
    // Default false is the safe direction: entitlement-shaped signals (region
    // enabled, quota above zero, machine type present in the catalog) say
    // nothing about whether a launch will succeed, so ranking on them would
    // promote regions with no capacity.
    const optedOut = makeSnapshotGateway(async () => ({
      availability: new Map(),
      complete: true,
    }));
    expect(optedOut.providesLiveCapacitySignal).toBe(false);

    const optedIn = makeSnapshotGateway(
      async () => ({ availability: new Map(), complete: true }),
      { providesLiveCapacitySignal: true },
    );
    expect(optedIn.providesLiveCapacitySignal).toBe(true);
  });

  it('reports the verified split alongside the order it already produced', async () => {
    const candidates: CandidateRegion[] = [
      { vmType: 'a', region: 'r1' },
      { vmType: 'a', region: 'r2' },
      { vmType: 'a', region: 'r3' },
    ];
    const gateway = makeSnapshotGateway(async () => ({
      availability: new Map([
        [
          candidateRegionKey(candidates[1]!),
          CandidateRegionAvailability.Verified,
        ],
        [
          candidateRegionKey(candidates[2]!),
          CandidateRegionAvailability.Unknown,
        ],
      ]),
      complete: true,
    }));

    const classified = await gateway.classifyCandidateRegions(
      candidates,
      false,
      'classify-split',
    );

    expect(classified.verified).toEqual([candidates[1]]);
    expect(classified.unknown).toEqual([candidates[0], candidates[2]]);
    // ordered is exactly what filterCandidateRegions has always returned.
    expect(classified.ordered).toEqual([
      candidates[1],
      candidates[0],
      candidates[2],
    ]);
  });

  it('verifies nothing when the snapshot fails open', async () => {
    // Fail-open must not look like "capacity confirmed nowhere" or, worse,
    // leave a stale verified set that target selection would rank on.
    const candidates: CandidateRegion[] = [
      { vmType: 'a', region: 'r1' },
      { vmType: 'a', region: 'r2' },
    ];
    const gateway = makeSnapshotGateway(
      async () => {
        throw new Error('preflight exploded');
      },
      { providesLiveCapacitySignal: true },
    );

    const classified = await gateway.classifyCandidateRegions(
      candidates,
      false,
      'classify-fail-open',
    );

    expect(classified.verified).toEqual([]);
    expect(classified.ordered).toEqual(candidates);
  });

  it('shares and caches complete snapshots by sorted exact-pair shape', async () => {
    const candidates = [
      { vmType: 'a', region: 'r1' },
      { vmType: 'b', region: 'r2' },
    ];
    const fetchSnapshot = vi.fn(
      async ({
        candidates,
      }: CandidateRegionSnapshotInput): Promise<TestSnapshot> => ({
        availability: new Map(
          candidates.map((candidate) => [
            candidateRegionKey(candidate),
            CandidateRegionAvailability.Verified,
          ]),
        ),
        complete: true,
      }),
    );
    const gateway = makeSnapshotGateway(fetchSnapshot);

    await expect(
      filterCandidatesByAvailability(gateway, candidates, {
        spot: true,
        workloadId: 'cache-1',
      }),
    ).resolves.toEqual(candidates);
    await expect(
      filterCandidatesByAvailability(gateway, [...candidates].reverse(), {
        spot: true,
        workloadId: 'cache-2',
      }),
    ).resolves.toEqual([...candidates].reverse());

    expect(fetchSnapshot).toHaveBeenCalledOnce();
  });

  it('uses an incomplete snapshot for the current result without retaining it', async () => {
    const candidates = [{ vmType: 'a', region: 'r1' }];
    const fetchSnapshot = vi
      .fn<SnapshotFetch>()
      .mockResolvedValueOnce({
        availability: new Map([
          [
            candidateRegionKey(candidates[0]!),
            CandidateRegionAvailability.Unknown,
          ],
        ]),
        complete: false,
      })
      .mockResolvedValueOnce({
        availability: new Map([
          [
            candidateRegionKey(candidates[0]!),
            CandidateRegionAvailability.Verified,
          ],
        ]),
        complete: true,
      });
    const gateway = makeSnapshotGateway(fetchSnapshot);

    await expect(
      filterCandidatesByAvailability(gateway, candidates, {
        spot: false,
        workloadId: 'incomplete-1',
      }),
    ).resolves.toEqual(candidates);
    await expect(
      filterCandidatesByAvailability(gateway, candidates, {
        spot: false,
        workloadId: 'incomplete-2',
      }),
    ).resolves.toEqual(candidates);

    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
  });

  it('treats a missing entry or assessment error as unknown', async () => {
    const throwing = { vmType: 'throws', region: 'r1' };
    const verified = { vmType: 'verified', region: 'r2' };
    const missing = { vmType: 'missing', region: 'r3' };
    const fetchSnapshot = vi.fn(
      async (): Promise<TestSnapshot> => ({
        availability: new Map([
          [candidateRegionKey(verified), CandidateRegionAvailability.Verified],
        ]),
        complete: true,
      }),
    );
    const gateway = makeSnapshotGateway(fetchSnapshot, {
      assess: (snapshot, candidate) => {
        if (candidate.vmType === 'throws') {
          throw new Error('bad provider projection');
        }
        return snapshot.availability.get(candidateRegionKey(candidate));
      },
    });

    await expect(
      filterCandidatesByAvailability(gateway, [throwing, verified, missing], {
        spot: false,
        workloadId: 'safe-assessment',
      }),
    ).resolves.toEqual([verified, throwing, missing]);
  });

  it('rejects locally ineligible candidates before cache lookup', async () => {
    const cache = new CandidatePreflightCache<TestSnapshot>();
    const cacheGet = vi.spyOn(cache, 'get');
    const fetchSnapshot = vi.fn<SnapshotFetch>();
    const gateway = makeSnapshotGateway(fetchSnapshot, {
      cache,
      assessLocalEligibility: (candidate) => ({
        eligible: false,
        reason: `${candidate.vmType} cannot use this disk`,
      }),
    });

    const error = await filterCandidatesByAvailability(
      gateway,
      [
        { vmType: 'first', region: 'r1' },
        { vmType: 'second', region: 'r2' },
      ],
      { spot: false, workloadId: 'locally-exhausted' },
    ).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(CandidateEligibilityExhaustedError);
    expect(error).toMatchObject({ message: 'first cannot use this disk' });
    expect(cacheGet).not.toHaveBeenCalled();
    expect(fetchSnapshot).not.toHaveBeenCalled();
  });

  it('uses only locally eligible candidates for cache keys and preflight', async () => {
    const firstRejected = { vmType: 'rejected-a', region: 'r1' };
    const secondRejected = { vmType: 'rejected-b', region: 'r2' };
    const eligible = { vmType: 'eligible', region: 'r3' };
    const fetchSnapshot = vi.fn(
      async ({ candidates }: CandidateRegionSnapshotInput) => ({
        availability: new Map(
          candidates.map((candidate) => [
            candidateRegionKey(candidate),
            CandidateRegionAvailability.Verified,
          ]),
        ),
        complete: true,
      }),
    );
    const gateway = makeSnapshotGateway(fetchSnapshot, {
      assessLocalEligibility: (candidate) =>
        candidate.vmType === eligible.vmType
          ? { eligible: true }
          : { eligible: false, reason: 'incompatible disk' },
    });

    await expect(
      filterCandidatesByAvailability(
        gateway,
        [firstRejected, eligible, eligible],
        { spot: false, workloadId: 'local-filter-1' },
      ),
    ).resolves.toEqual([eligible, eligible]);
    await expect(
      filterCandidatesByAvailability(gateway, [secondRejected, eligible], {
        spot: false,
        workloadId: 'local-filter-2',
      }),
    ).resolves.toEqual([eligible]);

    expect(fetchSnapshot).toHaveBeenCalledOnce();
    expect(fetchSnapshot.mock.calls[0]![0].candidates).toEqual([eligible]);
  });

  it.each(['deadline', 'abort'] as const)(
    'keeps local exclusions when the remote %s path fails open',
    async (failure) => {
      const rejected = { vmType: 'rejected', region: 'r1' };
      const eligible = { vmType: 'eligible', region: 'r2' };
      const fetchSnapshot = vi.fn<SnapshotFetch>();
      const gateway = makeSnapshotGateway(fetchSnapshot, {
        assessLocalEligibility: (candidate) =>
          candidate === eligible
            ? { eligible: true }
            : { eligible: false, reason: 'incompatible disk' },
      });
      const controller = new AbortController();
      if (failure === 'abort') controller.abort();

      await expect(
        filterCandidatesByAvailability(gateway, [rejected, eligible], {
          spot: false,
          workloadId: `local-${failure}`,
          signal: controller.signal,
          deadlineAt: failure === 'deadline' ? Date.now() : Date.now() + 10_000,
        }),
      ).resolves.toEqual([eligible]);
      expect(fetchSnapshot).not.toHaveBeenCalled();
    },
  );

  it('keeps local exclusions when the remote preflight fails', async () => {
    const rejected = { vmType: 'rejected', region: 'r1' };
    const eligible = { vmType: 'eligible', region: 'r2' };
    const fetchSnapshot = vi
      .fn<SnapshotFetch>()
      .mockRejectedValue(new Error('provider unavailable'));
    const gateway = makeSnapshotGateway(fetchSnapshot, {
      assessLocalEligibility: (candidate) =>
        candidate === eligible
          ? { eligible: true }
          : { eligible: false, reason: 'incompatible disk' },
    });

    await expect(
      filterCandidatesByAvailability(gateway, [rejected, eligible], {
        spot: false,
        workloadId: 'local-preflight-failure',
      }),
    ).resolves.toEqual([eligible]);
  });

  it('preserves fail-open behavior when no local eligibility hook exists', async () => {
    const candidates = [
      { vmType: 'a', region: 'r1' },
      { vmType: 'a', region: 'r1' },
      { vmType: 'b', region: 'r2' },
    ];
    const fetchSnapshot = vi.fn<SnapshotFetch>();
    const gateway = makeSnapshotGateway(fetchSnapshot);

    await expect(
      filterCandidatesByAvailability(gateway, candidates, {
        spot: false,
        workloadId: 'no-local-hook',
        deadlineAt: Date.now(),
      }),
    ).resolves.toEqual(candidates);
    expect(fetchSnapshot).not.toHaveBeenCalled();
  });

  it('lets a later caller outlive the first caller deadline on shared work', async () => {
    vi.useFakeTimers();
    const candidates = [
      { vmType: 'a', region: 'r1' },
      { vmType: 'b', region: 'r2' },
    ];
    let snapshotSignal: AbortSignal | undefined;
    let releaseSnapshot!: () => void;
    const fetchSnapshot = vi.fn(
      ({ signal }: CandidateRegionSnapshotInput) =>
        new Promise<TestSnapshot>((resolve, reject) => {
          snapshotSignal = signal;
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
          releaseSnapshot = () =>
            resolve({
              availability: new Map([
                [
                  candidateRegionKey(candidates[0]!),
                  CandidateRegionAvailability.Unavailable,
                ],
                [
                  candidateRegionKey(candidates[1]!),
                  CandidateRegionAvailability.Verified,
                ],
              ]),
              complete: true,
            });
        }),
    );
    const gateway = makeSnapshotGateway(fetchSnapshot);
    const shortWait = filterCandidatesByAvailability(gateway, candidates, {
      spot: false,
      workloadId: 'short-deadline',
      deadlineAt: Date.now() + 3_000,
    });
    await vi.advanceTimersByTimeAsync(500);
    const longWait = filterCandidatesByAvailability(gateway, candidates, {
      spot: false,
      workloadId: 'long-deadline',
      deadlineAt: Date.now() + 10_000,
    });
    let longWaitSettled = false;
    void longWait.then(() => {
      longWaitSettled = true;
    });

    await vi.advanceTimersByTimeAsync(501);

    await expect(shortWait).resolves.toEqual(candidates);
    expect(snapshotSignal?.aborted).toBe(false);
    expect(longWaitSettled).toBe(false);

    releaseSnapshot();
    await vi.advanceTimersByTimeAsync(0);

    await expect(longWait).resolves.toEqual([candidates[1]]);
    expect(fetchSnapshot).toHaveBeenCalledOnce();
  });

  it.each(['first', 'second'] as const)(
    'cancels only the %s caller wait without aborting shared work',
    async (cancelledPosition) => {
      vi.useFakeTimers();
      const candidates = [{ vmType: 'a', region: 'r1' }];
      let snapshotSignal: AbortSignal | undefined;
      let releaseSnapshot!: () => void;
      const fetchSnapshot = vi.fn(
        ({ signal }: CandidateRegionSnapshotInput) =>
          new Promise<TestSnapshot>((resolve, reject) => {
            snapshotSignal = signal;
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            });
            releaseSnapshot = () =>
              resolve({
                availability: new Map([
                  [
                    candidateRegionKey(candidates[0]!),
                    CandidateRegionAvailability.Unavailable,
                  ],
                ]),
                complete: true,
              });
          }),
      );
      const gateway = makeSnapshotGateway(fetchSnapshot);
      const firstCaller = new AbortController();
      const firstWait = filterCandidatesByAvailability(gateway, candidates, {
        spot: false,
        workloadId: 'first-caller',
        signal: firstCaller.signal,
        deadlineAt: Date.now() + 10_000,
      });
      const secondCaller = new AbortController();
      const secondWait = filterCandidatesByAvailability(gateway, candidates, {
        spot: false,
        workloadId: 'second-caller',
        signal: secondCaller.signal,
        deadlineAt: Date.now() + 10_000,
      });
      const cancelledWait =
        cancelledPosition === 'first' ? firstWait : secondWait;
      const survivingWait =
        cancelledPosition === 'first' ? secondWait : firstWait;
      let cancelledResult: CandidateRegion[] | undefined;
      void cancelledWait.then((result) => {
        cancelledResult = result;
      });

      const cancelledCaller =
        cancelledPosition === 'first' ? firstCaller : secondCaller;
      cancelledCaller.abort(new DOMException('caller stopped', 'AbortError'));
      await vi.advanceTimersByTimeAsync(0);

      expect(cancelledResult).toEqual(candidates);
      expect(snapshotSignal?.aborted).toBe(false);

      releaseSnapshot();
      await vi.advanceTimersByTimeAsync(0);

      await expect(survivingWait).resolves.toEqual([]);
      expect(fetchSnapshot).toHaveBeenCalledOnce();
    },
  );
});
