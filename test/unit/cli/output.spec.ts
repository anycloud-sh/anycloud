import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  formatImageName,
  formatCurrency,
  printError,
  printWorkloadHeader,
  formatWorkloadChoice,
  formatWorkloadChoices,
} from '../../../src/cli/utils/output.js';
import {
  formatAge,
  formatDurationCompact,
} from '../../../src/cli/utils/duration.js';
import { suggestFilter } from '../../../src/cli/utils/suggest-filter.js';
import { RELEASING_LABELS } from '../../../src/cli/utils/releasing.js';
import { formatSessionDisplay } from '../../../src/shared/session-display.js';
import { CloudType, DiskTier } from '../../../src/shared/cloud.js';
import { WorkloadState, WorkloadType } from '../../../src/shared/workload.js';
import {
  makeStatusWorkloadMetadata,
  makeWorkloadListRow,
} from '../helpers/fixtures.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

describe('printError', () => {
  afterEach(() => vi.restoreAllMocks());

  it('aligns continuation lines under the first line', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    printError('Permission denied: one.\nAsk your administrator.');
    expect(error.mock.calls[0][0].split('\n')).toEqual([
      expect.stringContaining('   ✗ Permission denied: one.'),
      expect.stringContaining('     Ask your administrator.'),
    ]);
  });
});

describe('formatImageName', () => {
  it('should strip registry prefix from ghcr.io images', () => {
    expect(formatImageName('ghcr.io/org/myapp:v2')).toBe('org/myapp:v2');
  });

  it('should strip registry prefix from docker.io images', () => {
    expect(formatImageName('docker.io/library/nginx:alpine')).toBe(
      'library/nginx:alpine',
    );
  });

  it('should return image as-is when no registry prefix', () => {
    expect(formatImageName('nginx:alpine')).toBe('nginx:alpine');
  });

  it('should handle org/image without registry', () => {
    expect(formatImageName('myorg/myapp')).toBe('myapp');
  });

  it('should handle deeply nested paths', () => {
    expect(formatImageName('registry.example.com/org/team/app:latest')).toBe(
      'org/team/app:latest',
    );
  });

  it('should handle bare image name', () => {
    expect(formatImageName('nginx')).toBe('nginx');
  });
});

describe('formatAge', () => {
  it('should format unknown timestamps', () => {
    expect(formatAge(null)).toBe('unknown');
  });

  it('should format seconds', () => {
    const now = Date.now();
    expect(formatAge(now - 30_000)).toBe('30s');
  });

  it('should format singular second', () => {
    const now = Date.now();
    expect(formatAge(now - 1_000)).toBe('1s');
  });

  it('should format minutes', () => {
    const now = Date.now();
    expect(formatAge(now - 5 * 60_000)).toBe('5m');
  });

  it('should format hours', () => {
    const now = Date.now();
    expect(formatAge(now - 3 * 3600_000)).toBe('3h');
  });

  it('should format days', () => {
    const now = Date.now();
    expect(formatAge(now - 2 * 86400_000)).toBe('2d');
  });
});

describe('formatDurationCompact', () => {
  it('formats days and hours', () => {
    expect(formatDurationCompact(5 * DAY_MS + 3 * HOUR_MS)).toBe('5d 3h');
  });

  it('formats hours and minutes', () => {
    expect(formatDurationCompact(2 * HOUR_MS + 15 * 60_000)).toBe('2h 15m');
  });

  it('formats minutes only', () => {
    expect(formatDurationCompact(45 * 60_000)).toBe('45m');
  });

  it('formats sub-minute durations as seconds', () => {
    expect(formatDurationCompact(45_000)).toBe('45s');
  });

  it('formats zero', () => {
    expect(formatDurationCompact(0)).toBe('0s');
  });

  it('formats days with zero hours', () => {
    expect(formatDurationCompact(3 * DAY_MS)).toBe('3d 0h');
  });
});

describe('formatCurrency', () => {
  it('formats with two decimals', () => {
    expect(formatCurrency(12.089)).toBe('$12.09');
  });

  it('adds thousands separators', () => {
    expect(formatCurrency(1234.5)).toBe('$1,234.50');
  });

  it('formats zero', () => {
    expect(formatCurrency(0)).toBe('$0.00');
  });
});

describe('printWorkloadHeader', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function captureHeader(
    ...args: Parameters<typeof printWorkloadHeader>
  ): string {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    printWorkloadHeader(...args);
    return (
      spy.mock.calls
        .map((call) => call.join(' '))
        .join('\n')
        // eslint-disable-next-line no-control-regex -- strip chalk's ANSI codes so assertions see plain text
        .replace(/\u001b\[[0-9;]*m/g, '')
    );
  }

  const now = Date.now();
  const completedAt = now - HOUR_MS;

  it('names the node pool beside the node pool cloud for a Service on a node pool', () => {
    const lines = captureHeader(
      makeStatusWorkloadMetadata({
        workloadType: WorkloadType.Service,
        cloudProvider: CloudType.AWS,
        region: null,
        vmType: null,
        nodePoolId: 'node-pool-aws',
        nodePoolName: 'aws-east',
        state: WorkloadState.Running,
      }),
    ).split('\n');
    expect(lines.some((line) => /Cloud.*AWS/.test(line))).toBe(true);
    expect(
      lines.some((line) => /Node pool.*aws-east \(node-pool-aws\)/.test(line)),
    ).toBe(true);
    expect(lines.some((line) => /Kubernetes/.test(line))).toBe(false);
  });

  it('0036/S19 shows the Deployment target for an identity-only Job', () => {
    const output = captureHeader(
      makeStatusWorkloadMetadata({
        deploymentId: 'deployment-model',
        image: null,
        cloudProvider: null,
        vmType: null,
      }),
    );
    expect(output).toContain('Deployment');
    expect(output).toContain('deployment-model');
    expect(output).not.toContain('Image');
  });

  it('shows wall-clock Duration, Billable, and estimated Cost', () => {
    const output = captureHeader(
      makeStatusWorkloadMetadata({
        state: WorkloadState.Completed,
        startedAt: completedAt - (10 * HOUR_MS + 33 * 60_000),
        completedAt,
        vmDurationMs: 36_331_499, // 10h 5m
        totalCost: 12.089,
        costSource: 'estimated',
      }),
    );
    expect(output).toContain('Duration');
    expect(output).toContain('10h 33m (ended 1h ago)');
    expect(output).toContain('Billable');
    expect(output).toContain('10h 5m');
    expect(output).toContain('$12.09 (est. @ $1.20/hr)');
  });

  it('breaks out how much billable time was spent awaiting release', () => {
    // The releasing marker is gone by now — cleanup finished. Without this the
    // wait is invisible in the final record.
    const output = captureHeader(
      makeStatusWorkloadMetadata({
        state: WorkloadState.Completed,
        startedAt: completedAt - HOUR_MS,
        completedAt,
        vmDurationMs: 54 * 60_000 + 30_000,
        awaitingReleaseMs: 26 * 60_000,
        totalCost: 14.88,
        costSource: 'estimated',
      }),
    );
    expect(output).toContain('54m (26m awaiting release)');
  });

  // Every teardown records a request, so a sub-minute round-trip must stay
  // silent — otherwise the note lands on virtually every terminated workload
  // as "(0s awaiting release)" and stops meaning anything.
  it.each([
    ['released in well under a second', 400],
    ['released after a few seconds of polling', 8_000],
    ['released just under the notice floor', 59_999],
    ['never recorded a request', 0],
  ])('omits the awaiting-release note when %s', (_case, awaitingReleaseMs) => {
    const output = captureHeader(
      makeStatusWorkloadMetadata({
        state: WorkloadState.Completed,
        startedAt: completedAt - HOUR_MS,
        completedAt,
        vmDurationMs: 30 * 60_000,
        awaitingReleaseMs,
      }),
    );
    expect(output).toContain('Billable');
    expect(output).not.toContain('awaiting release');
  });

  it('shows the note once the wait reaches a full minute', () => {
    const output = captureHeader(
      makeStatusWorkloadMetadata({
        state: WorkloadState.Completed,
        startedAt: completedAt - HOUR_MS,
        completedAt,
        vmDurationMs: 30 * 60_000,
        awaitingReleaseMs: 60_000,
      }),
    );
    expect(output).toContain('(1m awaiting release)');
  });

  it('drops the est. marker when cost is reconciled from billing', () => {
    const output = captureHeader(
      makeStatusWorkloadMetadata({
        state: WorkloadState.Completed,
        startedAt: completedAt - 10 * HOUR_MS,
        completedAt,
        vmDurationMs: 10 * HOUR_MS,
        totalCost: 12.0,
        costSource: 'actual',
      }),
    );
    expect(output).toContain('$12.00 ($1.20/hr)');
    expect(output).not.toContain('est.');
  });

  it('shows Billable but omits Cost when no VM was priced', () => {
    const output = captureHeader(
      makeStatusWorkloadMetadata({
        state: WorkloadState.Completed,
        startedAt: completedAt - 2 * HOUR_MS,
        completedAt,
        vmDurationMs: HOUR_MS,
        totalCost: 0,
        costSource: 'estimated',
      }),
    );
    expect(output).toContain('Billable');
    expect(output).not.toContain('Cost');
  });

  it('shows Cost without a rate when billable time is zero', () => {
    // Reconciled billing on failed-provisioning rows: cost without VM time.
    const output = captureHeader(
      makeStatusWorkloadMetadata({
        state: WorkloadState.Failed,
        startedAt: completedAt - 2 * HOUR_MS,
        completedAt,
        vmDurationMs: 0,
        totalCost: 5.0,
        costSource: 'actual',
      }),
    );
    expect(output).not.toContain('Billable');
    expect(output).toContain('Cost');
    expect(output).toContain('$5.00');
    expect(output).not.toContain('/hr');
  });

  it('shows on-demand and default disk size explicitly', () => {
    const output = captureHeader(
      makeStatusWorkloadMetadata({
        spot: false,
        diskSizeGb: null,
      }),
    );
    expect(output).toMatch(/\bSpot\s+no\b/);
    expect(output).toMatch(/\bDisk Size\s+default\b/);
  });

  it('shows spot and configured disk size explicitly', () => {
    const output = captureHeader(
      makeStatusWorkloadMetadata({
        spot: true,
        diskSizeGb: 400,
      }),
    );
    expect(output).toMatch(/\bVM\s+t3\.micro\b/);
    expect(output).not.toContain('(spot)');
    expect(output).toMatch(/\bSpot\s+yes\b/);
    expect(output).toMatch(/\bDisk Size\s+400 GB\b/);
  });

  it('shows an explicit checkpoint bucket for an on-demand workload', () => {
    const output = captureHeader(
      makeStatusWorkloadMetadata({ checkpointBucket: 'server-state' }),
      {
        checkpoint: {
          bucket: 'server-state',
          mount: '/mnt/checkpoint',
          retained: true,
        },
      },
    );
    expect(output).toMatch(
      /\bCheckpoint\s+server-state → \/mnt\/checkpoint \(retained\)/,
    );
  });

  it('shows that a Spot workload implicit checkpoint is deleted at cleanup', () => {
    const output = captureHeader(
      makeStatusWorkloadMetadata({ id: 'spot-job', spot: true }),
      {
        checkpoint: {
          bucket: 'spot-job',
          mount: '/mnt/checkpoint',
          retained: false,
        },
      },
    );
    expect(output).toMatch(
      /\bCheckpoint\s+spot-job → \/mnt\/checkpoint \(deleted at cleanup\)/,
    );
  });

  it('shows non-default disk tier', () => {
    const output = captureHeader(
      makeStatusWorkloadMetadata({
        diskTier: DiskTier.Medium,
      }),
    );
    expect(output).toMatch(/\bDisk Tier\s+medium\b/);
  });

  it('omits the high default disk tier from the header', () => {
    const output = captureHeader(
      makeStatusWorkloadMetadata({
        diskTier: DiskTier.High,
      }),
    );
    expect(output).not.toContain('Disk Tier');
  });

  it('keeps a VM URL-free even if stale DNS metadata exists', () => {
    const output = captureHeader(
      makeStatusWorkloadMetadata({
        id: 'vm-shell',
        workloadType: 'vm',
        dnsRecordId: 'stale-dns',
      }),
    );

    expect(output).not.toContain('https://vm-shell.anycloud.sh');
  });

  it('names why cleanup is pending on a terminal workload, and only then', () => {
    const pending = captureHeader(
      makeStatusWorkloadMetadata({
        state: WorkloadState.Terminated,
        completedAt,
        cleanedAt: null,
        vmCount: 1,
        cleanupError:
          'NamespaceDeletionDiscoveryFailure: Discovery failed for some groups',
      }),
    );
    expect(pending).toMatch(
      /Cleanup pending\s+NamespaceDeletionDiscoveryFailure: Discovery failed for some groups/,
    );
    expect(pending).toContain(RELEASING_LABELS.state.trim());

    // Cleaned: the reason is cleared by the API; a stale value is not shown.
    vi.restoreAllMocks();
    expect(
      captureHeader(
        makeStatusWorkloadMetadata({
          state: WorkloadState.Terminated,
          completedAt,
          cleanedAt: completedAt + 1,
          vmCount: 0,
          cleanupError: 'stale',
        }),
      ),
    ).not.toContain('Cleanup pending');
    // No failure yet, and older APIs without the field: nothing to say.
    for (const cleanupError of [null, undefined]) {
      vi.restoreAllMocks();
      expect(
        captureHeader(
          makeStatusWorkloadMetadata({
            state: WorkloadState.Terminated,
            completedAt,
            cleanedAt: null,
            vmCount: 1,
            cleanupError,
          }),
        ),
      ).not.toContain('Cleanup pending');
    }
  });

  it('omits Billable and Cost when aggregates are absent', () => {
    const output = captureHeader(
      makeStatusWorkloadMetadata({
        state: WorkloadState.Completed,
        startedAt: completedAt - 2 * HOUR_MS,
        completedAt,
      }),
    );
    expect(output).not.toContain('Billable');
    expect(output).not.toContain('Cost');
  });

  it('shows Age plus accruing Billable and Cost while running', () => {
    const output = captureHeader(
      makeStatusWorkloadMetadata({
        state: WorkloadState.Running,
        startedAt: now - 3 * HOUR_MS,
        completedAt: null,
        vmDurationMs: 2 * HOUR_MS,
        totalCost: 2.5,
        costSource: 'estimated',
      }),
    );
    expect(output).toContain('Age');
    expect(output).toContain('2h 0m');
    expect(output).toContain('$2.50 (est. @ $1.25/hr)');
  });

  it('shows a Session line with the friendly label', () => {
    const output = captureHeader(
      makeStatusWorkloadMetadata({
        session: '74e6d7c5-1d4b-470c-af47-103bffd77484',
        agent: 'claude',
        sessionLabel: 'gas-pipeline-tautomer-refactor',
      }),
    );
    expect(output).toContain('Session');
    expect(output).toContain('gas-pipeline-tautomer-refactor');
  });

  it('shows a Session line as agent:hash when there is no label', () => {
    const output = captureHeader(
      makeStatusWorkloadMetadata({
        session: '74e6d7c5-1d4b-470c-af47-103bffd77484',
        agent: 'claude',
        sessionLabel: null,
      }),
    );
    expect(output).toContain('Session');
    expect(output).toContain('claude:74e6d7');
  });

  it('omits the Session line when no session/agent is known', () => {
    const output = captureHeader(
      makeStatusWorkloadMetadata({
        session: null,
        agent: null,
        sessionLabel: null,
      }),
    );
    expect(output).not.toContain('Session');
  });
});

describe('formatSessionDisplay', () => {
  it('prefers the session label when present', () => {
    expect(
      formatSessionDisplay({
        session: '74e6d7c5-1d4b-470c-af47-103bffd77484',
        agent: 'claude',
        sessionLabel: 'gas-pipeline-tautomer-refactor',
      }),
    ).toBe('gas-pipeline-tautomer-refactor');
  });

  it('returns null when there is no session or label', () => {
    expect(
      formatSessionDisplay({
        session: null,
        agent: 'claude',
        sessionLabel: null,
      }),
    ).toBeNull();
  });

  it('renders agent:6char for a long session id without a label', () => {
    expect(
      formatSessionDisplay({
        session: '74e6d7c5-1d4b-470c-af47-103bffd77484',
        agent: 'claude',
        sessionLabel: null,
      }),
    ).toBe('claude:74e6d7');
  });

  it('returns the raw session id when short or agent is unknown', () => {
    expect(
      formatSessionDisplay({
        session: 'short-id',
        agent: null,
        sessionLabel: null,
      }),
    ).toBe('short-id');
  });
});

describe('suggestFilter', () => {
  const choices = [
    { title: 'us-east-1' },
    { title: 'us-west-2' },
    { title: 'eu-central-1' },
    { title: 'ap-southeast-1' },
  ];

  it('matches case-insensitively', async () => {
    expect(await suggestFilter('US', choices)).toEqual([
      { title: 'us-east-1' },
      { title: 'us-west-2' },
    ]);
    expect(await suggestFilter('Us', choices)).toEqual([
      { title: 'us-east-1' },
      { title: 'us-west-2' },
    ]);
  });

  it('returns all choices for empty input', async () => {
    expect(await suggestFilter('', choices)).toEqual(choices);
  });

  it('returns empty array when nothing matches', async () => {
    expect(await suggestFilter('zzz', choices)).toEqual([]);
  });

  it('matches substrings, not just prefixes', async () => {
    expect(await suggestFilter('central', choices)).toEqual([
      { title: 'eu-central-1' },
    ]);
  });
});

describe('formatWorkloadChoice', () => {
  it('0036/S19 formats and filters mixed Job choices using Deployment target identity', async () => {
    const choices = formatWorkloadChoices([
      makeWorkloadListRow({
        id: 'vm-job',
        image: 'org/app:latest',
        startedAt: 2_000,
      }),
      makeWorkloadListRow({
        id: 'deployment-job',
        deploymentId: 'long-deployment-model',
        image: null,
        startedAt: 1_000,
      }),
    ]);
    expect(choices[0].title).toContain('app');
    expect(choices[1].title).toContain('Deployment long-deployment-model');
    expect(await suggestFilter('long-deployment', choices)).toEqual([
      choices[1],
    ]);
  });

  it('includes the session label in the title (so the picker can filter by it)', () => {
    const choice = formatWorkloadChoice(
      makeWorkloadListRow({
        session: '74e6d7c5-1d4b-470c-af47-103bffd77484',
        agent: 'claude',
        sessionLabel: 'gas-pipeline-tautomer-refactor',
      }),
    );
    expect(choice.title).toContain('gas-pipeline-tautomer-refactor');
  });

  it('renders the agent:hash form in the title when there is no label', () => {
    const choice = formatWorkloadChoice(
      makeWorkloadListRow({
        session: '74e6d7c5-1d4b-470c-af47-103bffd77484',
        agent: 'claude',
        sessionLabel: null,
      }),
    );
    expect(choice.title).toContain('claude:74e6d7');
  });

  it('omits any session token when the workload has none', () => {
    const choice = formatWorkloadChoice(
      makeWorkloadListRow({ session: null, agent: null, sessionLabel: null }),
    );
    expect(choice.title).not.toContain('claude');
  });
});

describe('RELEASING_LABELS', () => {
  // status header, status VM list and list rows each render this concept with
  // the room they have. Editing one wording and missing the others is the
  // drift this pins: the vocabulary is shared even when the phrasing is not.
  it('keeps one vocabulary across every surface', () => {
    for (const label of Object.values(RELEASING_LABELS)) {
      expect(label).toContain('releasing');
    }
  });

  it('names the cost only where there is room to explain it', () => {
    expect(RELEASING_LABELS.state).toContain('still billing');
    expect(RELEASING_LABELS.stateCompact.length).toBeLessThan(
      RELEASING_LABELS.state.length,
    );
  });
});
