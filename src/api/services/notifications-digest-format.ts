/**
 * Daily notifications digest rendering: the plain text and Slack blocks for
 * one day's aggregated activity and spend.
 */

import { isLocalOwnerId } from './api-authentication.js';
import { digestUserKey } from './repositories/workload-spend.js';
import type {
  NotificationMessage,
  SlackRichTextBlock,
  SlackRichTextBlockElement,
  SlackRichTextListElement,
  SlackRichTextSectionElement,
} from '../../shared/notifications/contracts.js';
import {
  formatNotificationNumber,
  formatNotificationUsd,
} from '../../shared/notifications/format.js';

// Per-workload-type activity reported in the digest.
export interface DigestTypeSummary {
  initialSubmissions: number;
  resubmissions: number;
  total: number;
  completed: number;
  failed: number;
  errored: number;
  terminated: number;
  invalid: number;
  preempted: number;
  p50RuntimeMs: number | null;
}

export interface DigestSummary {
  jobs: DigestTypeSummary;
  services: DigestTypeSummary;
  vms: DigestTypeSummary;
  users: DigestUserSummary[];
}

export interface DigestUserSummary {
  userId: string;
  ownerUserId: string | null;
  jobs: DigestTypeSummary;
  services: DigestTypeSummary;
  vms: DigestTypeSummary;
  deployments: DigestDeploymentInventory;
  deploymentJobs: DigestDeploymentJobSummary[];
}

export interface DigestDeploymentInventory {
  presentAtEnd: number;
  created: number;
  deleted: number;
  hasActivity: boolean;
}

export interface DigestDeploymentJobSummary extends DigestTypeSummary {
  deploymentId: string;
  name: string;
  nodePoolName: string | null;
}

// Provisioned-VM activity and spend during the digest window, from a
// host-global scan split by workload type (see
// WorkloadSpendStore.sumVmSpendInWindow).
export interface DigestTypeSpend {
  runningCost: number;
  costSource: 'actual' | 'estimated';
  activeVmCount: number;
  unpricedVmCount: number;
  durationMs: number;
}

export interface DigestSpend {
  jobs: DigestTypeSpend;
  services: DigestTypeSpend;
  vms: DigestTypeSpend;
  users: DigestUserSpend[];
}

export interface DigestUserSpend {
  userId: string;
  ownerUserId: string | null;
  jobs: DigestTypeSpend;
  services: DigestTypeSpend;
  vms: DigestTypeSpend;
}

interface DigestSectionView {
  heading: string;
  items: string[];
  details: string[];
  breakdown?: { heading: string; items: string[] };
}

interface DigestUserView {
  // Null for a local API's one owner: the API label already names it.
  userId: string | null;
  sections: DigestSectionView[];
}

interface DigestView {
  title: string;
  spendLine: string | null;
  users: DigestUserView[];
}

// A digest section (and the digest itself) only exists when its workload
// type saw activity: something started, retried, ended, or had a provisioned
// VM in the window.
export function typeHasActivity(
  s: DigestTypeSummary,
  spend: DigestTypeSpend,
): boolean {
  return (
    s.initialSubmissions > 0 ||
    s.resubmissions > 0 ||
    s.total > 0 ||
    spend.activeVmCount > 0
  );
}

export function formatDigestNotification(
  dateLabel: string,
  s: DigestSummary,
  spend: DigestSpend,
): NotificationMessage {
  const view = buildDigestView(dateLabel, s, spend);
  return {
    text: formatDigestText(view),
    slack: { blocks: formatDigestSlackBlocks(view) },
  };
}

function buildDigestView(
  dateLabel: string,
  s: DigestSummary,
  spend: DigestSpend,
): DigestView {
  const summariesByUser = new Map(
    s.users.map((user) => [digestUserKey(user.ownerUserId, user.userId), user]),
  );
  const spendByUser = new Map(
    spend.users.map((user) => [
      digestUserKey(user.ownerUserId, user.userId),
      user,
    ]),
  );
  const userIds = [
    ...new Set([...summariesByUser.keys(), ...spendByUser.keys()]),
  ].sort();
  const users: DigestUserView[] = [];
  const nameCounts = new Map<string, number>();
  for (const userKey of userIds) {
    const user = summariesByUser.get(userKey) ?? spendByUser.get(userKey)!;
    const name = user.userId.toLowerCase();
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }
  for (const userKey of userIds) {
    const identity = summariesByUser.get(userKey) ?? spendByUser.get(userKey)!;
    const userSummary =
      summariesByUser.get(userKey) ?? emptyDigestUserSummary();
    const userSpend = spendByUser.get(userKey) ?? emptyDigestUserSpend();
    const sections: DigestSectionView[] = [];
    if (typeHasActivity(userSummary.jobs, userSpend.jobs)) {
      const jobs = buildDigestSection('jobs', userSummary.jobs, userSpend.jobs);
      jobs.breakdown = buildDeploymentJobBreakdown(userSummary.deploymentJobs);
      sections.push(jobs);
    }
    if (typeHasActivity(userSummary.services, userSpend.services)) {
      sections.push(
        buildDigestSection(
          'services',
          userSummary.services,
          userSpend.services,
        ),
      );
    }
    if (typeHasActivity(userSummary.vms, userSpend.vms)) {
      sections.push(buildDigestSection('vms', userSummary.vms, userSpend.vms));
    }
    if (userSummary.deployments.hasActivity) {
      const inventory = userSummary.deployments;
      const items: string[] = [];
      if (inventory.presentAtEnd > 0) {
        items.push(
          `${formatNotificationNumber(inventory.presentAtEnd)} present at day end`,
        );
      }
      if (inventory.created > 0) {
        items.push(`${formatNotificationNumber(inventory.created)} created`);
      }
      if (inventory.deleted > 0) {
        items.push(`${formatNotificationNumber(inventory.deleted)} deleted`);
      }
      sections.push({
        heading: '☸️ Kubernetes Deployments',
        items: [items.join(' · ')],
        details: [],
      });
    }
    if (sections.length > 0) {
      const account =
        identity.ownerUserId === null
          ? 'account ID unavailable'
          : `GitHub user ${identity.ownerUserId}`;
      const userId =
        identity.ownerUserId !== null && isLocalOwnerId(identity.ownerUserId)
          ? null
          : (nameCounts.get(identity.userId.toLowerCase()) ?? 0) > 1
            ? `${identity.userId} (${account})`
            : identity.userId;
      users.push({ userId, sections });
    }
  }
  return {
    title: `anycloud usage on ${dateLabel} (UTC)`,
    spendLine: formatDigestSpendLine(spend),
    users: users.sort((a, b) => (a.userId ?? '').localeCompare(b.userId ?? '')),
  };
}

const DIGEST_DEPLOYMENT_DETAIL_LIMIT = 5;

function buildDeploymentJobBreakdown(
  targets: DigestDeploymentJobSummary[],
): DigestSectionView['breakdown'] {
  if (targets.length === 0) return undefined;
  const activity = (target: DigestDeploymentJobSummary) =>
    target.initialSubmissions + target.resubmissions + target.total;
  const sorted = [...targets].sort(
    (a, b) =>
      activity(b) - activity(a) ||
      a.name.localeCompare(b.name) ||
      a.deploymentId.localeCompare(b.deploymentId),
  );
  const targetLabel = (target: DigestDeploymentJobSummary) =>
    target.nodePoolName === null
      ? target.name
      : `${target.name} / ${target.nodePoolName}`;
  const labelCounts = new Map<string, number>();
  for (const target of targets) {
    const label = targetLabel(target);
    labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
  }
  const items = sorted
    .slice(0, DIGEST_DEPLOYMENT_DETAIL_LIMIT)
    .map((target) => {
      const base = targetLabel(target);
      const label =
        (labelCounts.get(base) ?? 0) > 1
          ? `${base} (${target.deploymentId})`
          : base;
      return `${label}: ${formatDeploymentJobActivity(target)}`;
    });
  const others = sorted.slice(DIGEST_DEPLOYMENT_DETAIL_LIMIT);
  if (others.length > 0) {
    const total = emptyDigestTypeSummary();
    for (const target of others) {
      for (const field of [
        'initialSubmissions',
        'resubmissions',
        'total',
        'completed',
        'failed',
        'errored',
        'terminated',
        'invalid',
      ] as const) {
        total[field] += target[field];
      }
    }
    const noun = others.length === 1 ? 'Deployment' : 'Deployments';
    items.push(
      `${formatNotificationNumber(others.length)} other ${noun}: ${formatDeploymentJobActivity(total)}`,
    );
  }
  return { heading: 'By Kubernetes Deployment — included above', items };
}

function formatDeploymentJobActivity(summary: DigestTypeSummary): string {
  const items: string[] = [];
  if (summary.initialSubmissions > 0) {
    items.push(
      `${formatNotificationNumber(summary.initialSubmissions)} submitted`,
    );
  }
  if (summary.resubmissions > 0) {
    items.push(
      `${formatNotificationNumber(summary.resubmissions)} resubmitted`,
    );
  }
  for (const state of [
    'completed',
    'failed',
    'errored',
    'terminated',
    'invalid',
  ] as const) {
    if (summary[state] > 0) {
      items.push(`${formatNotificationNumber(summary[state])} ${state}`);
    }
  }
  return items.join(' · ');
}

function formatDigestSpendLine(spend: DigestSpend): string | null {
  const activeVmCount =
    spend.jobs.activeVmCount +
    spend.services.activeVmCount +
    spend.vms.activeVmCount;
  if (activeVmCount === 0) return null;
  const unpricedVmCount =
    spend.jobs.unpricedVmCount +
    spend.services.unpricedVmCount +
    spend.vms.unpricedVmCount;
  const runningCost =
    spend.jobs.runningCost + spend.services.runningCost + spend.vms.runningCost;
  const costSource =
    spend.jobs.costSource === 'estimated' ||
    spend.services.costSource === 'estimated' ||
    spend.vms.costSource === 'estimated'
      ? 'estimated'
      : 'actual';
  const unpricedVms = unpricedVmCount === 1 ? 'VM' : 'VMs';
  // A VM restarted in place can have priced and unpriced rows.
  if (unpricedVmCount === activeVmCount && runningCost === 0) {
    return `💰 Compute spend: unavailable (${formatNotificationNumber(unpricedVmCount)} unpriced ${unpricedVms})`;
  }
  if (unpricedVmCount > 0) {
    const pricedSource =
      costSource === 'estimated' ? ', priced portion estimated' : '';
    return `💰 Compute spend: ${formatNotificationUsd(runningCost)} (partial${pricedSource}; ${formatNotificationNumber(unpricedVmCount)} unpriced ${unpricedVms})`;
  }
  return `💰 Compute spend: ${formatNotificationUsd(runningCost)}${costSource === 'estimated' ? ' (est.)' : ''}`;
}

function formatDigestText(view: DigestView): string {
  const lines = [`*${view.title}*`];
  if (view.spendLine) lines.push(view.spendLine);
  for (const user of view.users) {
    lines.push('');
    if (user.userId !== null) lines.push(`*👤 ${user.userId}*`);
    for (const section of user.sections) {
      lines.push(section.heading);
      lines.push(...section.items.map((item) => `   ${item}`));
      lines.push(...section.details.map((detail) => `      ${detail}`));
      if (section.breakdown) {
        lines.push(`   ${section.breakdown.heading}`);
        lines.push(...section.breakdown.items.map((item) => `      ${item}`));
      }
    }
  }
  return lines.join('\n');
}

function formatDigestSlackBlocks(view: DigestView): SlackRichTextBlock[] {
  const elements: SlackRichTextBlockElement[] = [
    richTextSection(view.title, true),
  ];
  if (view.spendLine) elements.push(richTextSection(view.spendLine));
  for (const user of view.users) {
    for (const [index, section] of user.sections.entries()) {
      // Keep the user and first workload heading in one paragraph. Slack adds
      // vertical padding between rich-text elements, so separate elements make
      // a single user's section look more spread out than intended.
      const heading =
        index === 0 && user.userId !== null
          ? `👤 ${user.userId}\n${section.heading}`
          : section.heading;
      elements.push(richTextSection(heading, true));
      if (section.items.length > 0) {
        elements.push(richTextList(section.items, 0));
      }
      if (section.details.length > 0) {
        elements.push(richTextList(section.details, 1));
      }
      if (section.breakdown) {
        elements.push(richTextList([section.breakdown.heading], 0));
        elements.push(richTextList(section.breakdown.items, 1));
      }
    }
  }
  return [{ type: 'rich_text', elements }];
}

function richTextSection(
  text: string,
  bold = false,
): SlackRichTextSectionElement {
  return {
    type: 'rich_text_section',
    elements: [
      {
        type: 'text',
        text,
        ...(bold ? { style: { bold: true } } : {}),
      },
    ],
  };
}

function richTextList(
  items: string[],
  indent: number,
): SlackRichTextListElement {
  return {
    type: 'rich_text_list',
    style: 'bullet',
    indent,
    elements: items.map((item) => richTextSection(item)),
  };
}

function emptyDigestTypeSummary(): DigestTypeSummary {
  return {
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
  };
}

function emptyDigestUserSummary(): DigestUserSummary {
  return {
    userId: '',
    ownerUserId: null,
    jobs: emptyDigestTypeSummary(),
    services: emptyDigestTypeSummary(),
    vms: emptyDigestTypeSummary(),
    deployments: {
      presentAtEnd: 0,
      created: 0,
      deleted: 0,
      hasActivity: false,
    },
    deploymentJobs: [],
  };
}

function emptyDigestTypeSpend(): DigestTypeSpend {
  return {
    runningCost: 0,
    costSource: 'actual',
    activeVmCount: 0,
    unpricedVmCount: 0,
    durationMs: 0,
  };
}

function emptyDigestUserSpend(): DigestUserSpend {
  return {
    userId: '',
    ownerUserId: null,
    jobs: emptyDigestTypeSpend(),
    services: emptyDigestTypeSpend(),
    vms: emptyDigestTypeSpend(),
  };
}

// One digest section. Lines with a zero count are omitted — a section states
// what happened, not everything that didn't. Services say "launched" and VMs
// say "created" instead of "initial submissions". Both skip the median: their
// long-running lifetimes make that number unhelpful. VMs also promote their
// terminal outcomes into the main list instead of nesting them beneath a
// separate "ended" total.
function buildDigestSection(
  kind: 'jobs' | 'services' | 'vms',
  s: DigestTypeSummary,
  spend: DigestTypeSpend,
): DigestSectionView {
  const heading =
    kind === 'jobs'
      ? '📦 Jobs'
      : kind === 'services'
        ? '🌐 Services'
        : '🖥️ VMs';
  const usage: string[] = [];
  if (spend.activeVmCount > 0) {
    // When every VM in the section is unpriced there is no dollar figure to
    // show; the global spend line already calls out the unpriced VMs.
    if (spend.unpricedVmCount < spend.activeVmCount || spend.runningCost > 0) {
      let cost = formatNotificationUsd(spend.runningCost);
      if (spend.unpricedVmCount > 0) cost += ' (partial)';
      else if (spend.costSource === 'estimated') cost += ' (est.)';
      usage.push(cost);
    }
    usage.push(
      `${formatDuration(spend.durationMs)} across ${formatNotificationNumber(spend.activeVmCount)} ${spend.activeVmCount === 1 ? 'VM' : 'VMs'}`,
    );
  }
  const items: string[] = [];
  const details: string[] = [];
  if (s.initialSubmissions > 0) {
    const noun =
      kind === 'jobs'
        ? s.initialSubmissions === 1
          ? 'initial submission'
          : 'initial submissions'
        : kind === 'services'
          ? 'launched'
          : 'created';
    items.push(`🚀 ${formatNotificationNumber(s.initialSubmissions)} ${noun}`);
  }
  if (s.resubmissions > 0) {
    const noun = s.resubmissions === 1 ? 'resubmission' : 'resubmissions';
    items.push(`🔁 ${formatNotificationNumber(s.resubmissions)} ${noun}`);
  }
  if (s.total > 0) {
    const states: string[] = [];
    if (s.completed > 0)
      states.push(`✅ ${formatNotificationNumber(s.completed)} completed`);
    if (s.failed > 0)
      states.push(`❌ ${formatNotificationNumber(s.failed)} failed`);
    if (s.errored > 0)
      states.push(`⚠️ ${formatNotificationNumber(s.errored)} errored`);
    if (s.terminated > 0)
      states.push(`⏹️ ${formatNotificationNumber(s.terminated)} terminated`);
    if (s.invalid > 0)
      states.push(`🚫 ${formatNotificationNumber(s.invalid)} invalid`);
    if (kind === 'vms') {
      items.push(states.join(' · '));
    } else {
      items.push(`🏁 ${formatNotificationNumber(s.total)} ended`);
      details.push(states.join(' · '));
    }
    if (s.preempted > 0) {
      const rate = Math.round((s.preempted / s.total) * 100);
      const verb = s.preempted === 1 ? 'was' : 'were';
      const pronoun = s.preempted === 1 ? 'its' : 'their';
      details.push(
        `⚡ ${formatNotificationNumber(s.preempted)} ${verb} preempted at least once during ${pronoun} run (${rate}%)`,
      );
    }
    if (kind === 'jobs' && s.p50RuntimeMs !== null) {
      details.push(`⏱️ Median duration: ${formatDuration(s.p50RuntimeMs)}`);
    }
  }
  return {
    heading: usage.length > 0 ? `${heading} — ${usage.join(' · ')}` : heading,
    items,
    details,
  };
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${formatNotificationNumber(Math.round(ms / 1000))}s`;
  if (ms < 3_600_000)
    return `${formatNotificationNumber(Math.round(ms / 60_000))}m`;
  return `${formatNotificationNumber(ms / 3_600_000, 1)}h`;
}
