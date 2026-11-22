import { describe, it, expect } from 'vitest';
import {
  formatDigestNotification,
  type DigestSpend,
  type DigestSummary,
  type DigestTypeSpend,
  type DigestTypeSummary,
  type DigestUserSpend,
  type DigestUserSummary,
} from '../../../src/api/services/notifications-digest-format.js';

describe('digest text rendering', () => {
  // The shipped entry point is formatDigestNotification; its `text` is what a
  // plain-text destination receives.
  const digestText = (
    ...args: Parameters<typeof formatDigestNotification>
  ): string => formatDigestNotification(...args).text;

  const typeSummary = (
    o: Partial<DigestTypeSummary> = {},
  ): DigestTypeSummary => ({
    initialSubmissions: 0,
    resubmissions: 0,
    total: 0,
    completed: 0,
    failed: 0,
    errored: 0,
    terminated: 0,
    invalid: 0,
    preempted: 0,
    p50RuntimeMs: null,
    ...o,
  });
  const summary = (
    o: {
      jobs?: Partial<DigestTypeSummary>;
      services?: Partial<DigestTypeSummary>;
      vms?: Partial<DigestTypeSummary>;
      users?: Array<{
        userId: string;
        ownerUserId?: string;
        jobs?: Partial<DigestTypeSummary>;
        services?: Partial<DigestTypeSummary>;
        vms?: Partial<DigestTypeSummary>;
      }>;
    } = {},
  ): DigestSummary => {
    const jobs = typeSummary(o.jobs);
    const services = typeSummary(o.services);
    const vms = typeSummary(o.vms);
    const defaultUsers: DigestUserSummary[] = [
      {
        userId: 'alice',
        ownerUserId: null,
        jobs,
        services,
        vms,
      },
    ];
    return {
      jobs,
      services,
      vms,
      users:
        o.users?.map((user) => ({
          userId: user.userId,
          ownerUserId: user.ownerUserId ?? null,
          jobs: typeSummary(user.jobs),
          services: typeSummary(user.services),
          vms: typeSummary(user.vms),
        })) ?? defaultUsers,
    };
  };
  const typeSpend = (o: Partial<DigestTypeSpend> = {}): DigestTypeSpend => ({
    runningCost: 0,
    costSource: 'actual',
    activeVmCount: 0,
    unpricedVmCount: 0,
    durationMs: 0,
    ...o,
  });
  const spend = (
    o: {
      jobs?: Partial<DigestTypeSpend>;
      services?: Partial<DigestTypeSpend>;
      vms?: Partial<DigestTypeSpend>;
      users?: Array<{
        userId: string;
        ownerUserId?: string;
        jobs?: Partial<DigestTypeSpend>;
        services?: Partial<DigestTypeSpend>;
        vms?: Partial<DigestTypeSpend>;
      }>;
    } = {},
  ): DigestSpend => {
    const jobs = typeSpend(o.jobs);
    const services = typeSpend(o.services);
    const vms = typeSpend(o.vms);
    const defaultUsers: DigestUserSpend[] = [
      { userId: 'alice', ownerUserId: null, jobs, services, vms },
    ];
    return {
      jobs,
      services,
      vms,
      users:
        o.users?.map((user) => ({
          userId: user.userId,
          ownerUserId: user.ownerUserId ?? null,
          jobs: typeSpend(user.jobs),
          services: typeSpend(user.services),
          vms: typeSpend(user.vms),
        })) ?? defaultUsers,
    };
  };

  it('renders a jobs section with usage, submissions, and outcomes', () => {
    const msg = digestText(
      '2026-05-19',
      summary({
        jobs: {
          initialSubmissions: 7,
          resubmissions: 2,
          total: 6,
          completed: 2,
          failed: 1,
          errored: 1,
          terminated: 1,
          invalid: 1,
          preempted: 2,
          p50RuntimeMs: 180_000,
        },
      }),
      spend({
        jobs: {
          runningCost: 4.25,
          activeVmCount: 3,
          durationMs: 2.5 * 60 * 60 * 1000,
        },
      }),
    );
    const lines = msg.split('\n');
    expect(lines[0]).toBe('*anycloud usage on 2026-05-19 (UTC)*');
    expect(lines[1]).toBe('💰 Compute spend: $4.25');
    expect(lines[2]).toBe('');
    expect(lines[3]).toBe('*👤 alice*');
    expect(lines[4]).toBe('📦 Jobs — $4.25 · 2.5h across 3 VMs');
    expect(lines[5]).toBe('   🚀 7 initial submissions');
    expect(lines[6]).toBe('   🔁 2 resubmissions');
    expect(lines[7]).toBe('   🏁 6 ended');
    expect(lines[8]).toBe(
      '      ✅ 2 completed · ❌ 1 failed · ⚠️ 1 errored · ⏹️ 1 terminated · 🚫 1 invalid',
    );
    expect(lines[9]).toBe(
      '      ⚡ 2 were preempted at least once during their run (33%)',
    );
    expect(lines[10]).toBe('      ⏱️ Median duration: 3m');
    expect(msg).not.toContain('🌐 Services');
  });

  it('uses Block Kit lists for reliable summary and detail indentation', () => {
    const notification = formatDigestNotification(
      '2026-05-19',
      summary({
        jobs: {
          initialSubmissions: 7,
          resubmissions: 2,
          total: 6,
          completed: 5,
          failed: 1,
          preempted: 1,
          p50RuntimeMs: 180_000,
        },
      }),
      spend({
        jobs: {
          runningCost: 4.25,
          activeVmCount: 3,
          durationMs: 2.5 * 60 * 60 * 1000,
        },
      }),
    );

    expect(notification.text).toContain('   🚀 7 initial submissions');
    const [block] = notification.slack!.blocks;
    expect(block.type).toBe('rich_text');
    expect(block.elements[2]).toMatchObject({
      type: 'rich_text_section',
      elements: [
        {
          text: '👤 alice\n📦 Jobs — $4.25 · 2.5h across 3 VMs',
          style: { bold: true },
        },
      ],
    });
    const lists = block.elements.filter(
      (element) => element.type === 'rich_text_list',
    );
    expect(lists.map((list) => list.indent)).toEqual([0, 1]);
    expect(
      lists[0].elements.map((element) => element.elements[0].text),
    ).toEqual(['🚀 7 initial submissions', '🔁 2 resubmissions', '🏁 6 ended']);
    expect(
      lists[1].elements.map((element) => element.elements[0].text),
    ).toEqual([
      '✅ 5 completed · ❌ 1 failed',
      '⚡ 1 was preempted at least once during its run (17%)',
      '⏱️ Median duration: 3m',
    ]);
    for (const list of lists) {
      for (const element of list.elements) {
        expect(element.elements[0].text).not.toMatch(/^\s/);
      }
    }
  });

  it('adds thousands separators to large numbers in Slack text and blocks', () => {
    const notification = formatDigestNotification(
      '2026-05-19',
      summary({
        jobs: {
          initialSubmissions: 12_345,
          resubmissions: 1_234,
          total: 12_000,
          completed: 10_000,
          failed: 2_000,
          preempted: 1_234,
          p50RuntimeMs: 1_234.5 * 60 * 60 * 1000,
        },
      }),
      spend({
        jobs: {
          runningCost: 1_234_567.89,
          activeVmCount: 12_345,
          unpricedVmCount: 1_234,
          durationMs: 1_234.5 * 60 * 60 * 1000,
        },
      }),
    );

    expect(notification.text).toContain(
      '💰 Compute spend: $1,234,567.89 (partial; 1,234 unpriced VMs)',
    );
    expect(notification.text).toContain(
      '📦 Jobs — $1,234,567.89 (partial) · 1,234.5h across 12,345 VMs',
    );
    expect(notification.text).toContain('🚀 12,345 initial submissions');
    expect(notification.text).toContain('🔁 1,234 resubmissions');
    expect(notification.text).toContain('🏁 12,000 ended');
    expect(notification.text).toContain(
      '✅ 10,000 completed · ❌ 2,000 failed',
    );
    expect(notification.text).toContain(
      '⚡ 1,234 were preempted at least once during their run (10%)',
    );
    expect(notification.text).toContain('⏱️ Median duration: 1,234.5h');

    const [block] = notification.slack!.blocks;
    expect(block.elements[1]).toMatchObject({
      elements: [
        {
          text: '💰 Compute spend: $1,234,567.89 (partial; 1,234 unpriced VMs)',
        },
      ],
    });
    expect(block.elements[2]).toMatchObject({
      elements: [
        {
          text: expect.stringContaining(
            '$1,234,567.89 (partial) · 1,234.5h across 12,345 VMs',
          ),
        },
      ],
    });
  });

  it('renders a services section with launches but no median', () => {
    const msg = digestText(
      '2026-05-19',
      summary({
        services: {
          initialSubmissions: 1,
          total: 1,
          terminated: 1,
          p50RuntimeMs: 60_000,
        },
      }),
      spend({
        services: {
          runningCost: 24,
          costSource: 'estimated',
          activeVmCount: 1,
          durationMs: 24 * 60 * 60 * 1000,
        },
      }),
    );
    const lines = msg.split('\n');
    expect(lines[1]).toBe('💰 Compute spend: $24.00 (est.)');
    expect(lines[2]).toBe('');
    expect(lines[3]).toBe('*👤 alice*');
    expect(lines[4]).toBe('🌐 Services — $24.00 (est.) · 24.0h across 1 VM');
    expect(lines[5]).toBe('   🚀 1 launched');
    expect(lines[6]).toBe('   🏁 1 ended');
    expect(lines[7]).toBe('      ⏹️ 1 terminated');
    expect(msg).not.toContain('📦 Jobs');
    expect(msg).not.toContain('Median duration');
  });

  it('renders a VM section without repeating ended and terminated', () => {
    const notification = formatDigestNotification(
      '2026-05-19',
      summary({
        vms: {
          initialSubmissions: 1,
          total: 1,
          terminated: 1,
          p50RuntimeMs: 60_000,
        },
      }),
      spend({
        vms: {
          runningCost: 3,
          activeVmCount: 1,
          durationMs: 2 * 60 * 60 * 1000,
        },
      }),
    );
    const msg = notification.text;
    const lines = msg.split('\n');
    expect(lines[4]).toBe('🖥️ VMs — $3.00 · 2.0h across 1 VM');
    expect(lines[5]).toBe('   🚀 1 created');
    expect(lines[6]).toBe('   ⏹️ 1 terminated');
    expect(msg).not.toContain('ended');
    expect(msg).not.toContain('📦 Jobs');
    expect(msg).not.toContain('🌐 Services');
    expect(msg).not.toContain('Median duration');

    const [block] = notification.slack!.blocks;
    const lists = block.elements.filter(
      (element) => element.type === 'rich_text_list',
    );
    expect(lists).toHaveLength(1);
    expect(lists[0].indent).toBe(0);
    expect(
      lists[0].elements.map((element) => element.elements[0].text),
    ).toEqual(['🚀 1 created', '⏹️ 1 terminated']);
  });

  it('renders jobs and services sections independently', () => {
    const msg = digestText(
      '2026-05-19',
      summary({
        jobs: { initialSubmissions: 3, total: 2, completed: 2 },
      }),
      spend({
        jobs: {
          runningCost: 1.5,
          activeVmCount: 2,
          durationMs: 60 * 60 * 1000,
        },
        services: {
          runningCost: 2.5,
          activeVmCount: 1,
          durationMs: 60 * 60 * 1000,
        },
      }),
    );
    expect(msg).toContain('💰 Compute spend: $4.00');
    expect(msg).toContain('📦 Jobs — $1.50 · 1.0h across 2 VMs');
    expect(msg).toContain('🌐 Services — $2.50 · 1.0h across 1 VM');
    const aliceSection = msg.slice(msg.indexOf('*👤 alice*'));
    expect(aliceSection).not.toContain('\n\n');
  });

  it('omits zero-count lines, spend without VMs, and idle sections', () => {
    const msg = digestText(
      '2026-05-19',
      summary({ jobs: { initialSubmissions: 1 } }),
      spend(),
    );
    const lines = msg.split('\n');
    expect(lines[1]).toBe('');
    expect(lines[2]).toBe('*👤 alice*');
    expect(lines[3]).toBe('📦 Jobs');
    expect(lines[4]).toBe('   🚀 1 initial submission');
    expect(lines).toHaveLength(5);
    expect(msg).not.toContain('💰');
    expect(msg).not.toContain('🔁');
    expect(msg).not.toContain('🏁');
    expect(msg).not.toContain('⚡');
    expect(msg).not.toContain('🌐 Services');
  });

  it('renders every participating user once in sorted order', () => {
    const msg = digestText(
      '2026-05-19',
      summary({
        jobs: { initialSubmissions: 3 },
        users: [
          { userId: 'bob', jobs: { initialSubmissions: 2 } },
          { userId: 'alice', jobs: { initialSubmissions: 1 } },
        ],
      }),
      spend({
        services: {
          runningCost: 2,
          activeVmCount: 1,
          durationMs: 60 * 60 * 1000,
        },
        users: [
          {
            userId: 'carol',
            services: {
              runningCost: 2,
              activeVmCount: 1,
              durationMs: 60 * 60 * 1000,
            },
          },
          { userId: 'bob' },
        ],
      }),
    );
    expect(msg.match(/\*👤 alice\*/g)).toHaveLength(1);
    expect(msg.match(/\*👤 bob\*/g)).toHaveLength(1);
    expect(msg.match(/\*👤 carol\*/g)).toHaveLength(1);
    expect(msg.indexOf('*👤 alice*')).toBeLessThan(msg.indexOf('*👤 bob*'));
    expect(msg.indexOf('*👤 bob*')).toBeLessThan(msg.indexOf('*👤 carol*'));
    expect(msg).toContain('🚀 1 initial submission');
    expect(msg).toContain('🚀 2 initial submissions');
    expect(msg).toContain('🌐 Services — $2.00 · 1.0h across 1 VM');
  });

  it('reports unpriced VM usage instead of claiming actual zero spend', () => {
    const msg = digestText(
      '2026-05-19',
      summary(),
      spend({
        jobs: {
          activeVmCount: 1,
          unpricedVmCount: 1,
          durationMs: 60 * 60 * 1000,
        },
      }),
    );
    expect(msg).toContain('💰 Compute spend: unavailable (1 unpriced VM)');
    expect(msg).not.toContain('💰 Compute spend: $0.00');
    expect(msg).toContain('📦 Jobs — 1.0h across 1 VM');
  });

  it('marks spend partial when only some VMs are priced', () => {
    const msg = digestText(
      '2026-05-19',
      summary(),
      spend({
        jobs: {
          runningCost: 5,
          activeVmCount: 2,
          unpricedVmCount: 1,
          durationMs: 60 * 60 * 1000,
        },
      }),
    );
    expect(msg).toContain('💰 Compute spend: $5.00 (partial; 1 unpriced VM)');
    expect(msg).toContain('📦 Jobs — $5.00 (partial) · 1.0h across 2 VMs');
  });

  it('marks spend partial when a VM restarted in place has one priced row', () => {
    const msg = digestText(
      '2026-05-19',
      summary(),
      spend({
        jobs: {
          runningCost: 5,
          activeVmCount: 1,
          unpricedVmCount: 1,
          durationMs: 60 * 60 * 1000,
        },
      }),
    );
    expect(msg).toContain('💰 Compute spend: $5.00 (partial; 1 unpriced VM)');
    expect(msg).toContain('📦 Jobs — $5.00 (partial) · 1.0h across 1 VM');
  });
});
