import chalk from 'chalk';
import type { QuotaStatusEntry } from '../../shared/api-contract/quota-schemas.js';
import {
  isCurrentStatusEntry,
  isLocalOperationStatusEntry,
  matrixFamilyFor,
  quotaBucket,
  statusCellValue,
  type QuotaBucket,
  type QuotaStatusView,
  type StatusMatrixFamily,
} from '../use-cases/quota-status.js';

function quotaTypeLabel(spotValues: boolean[]): string {
  if (spotValues.length === 1) {
    return spotValues[0] ? 'Spot / preemptible' : 'On-demand';
  }
  if (spotValues.includes(false) && spotValues.includes(true)) {
    return 'On-demand + Spot / preemptible';
  }
  return 'None';
}

export function quotaStatusTypeScope(
  spotValues: boolean[] | undefined,
): string {
  return spotValues
    ? quotaTypeLabel(spotValues).toLowerCase()
    : 'all quota types';
}

const BUCKET_COLOR: Record<QuotaBucket, (text: string) => string> = {
  approved: chalk.green,
  partial: chalk.yellow,
  denied: chalk.red,
  open: chalk.yellow,
};

// Emoji render two terminal columns wide but measure one code unit (✅ ⏳ ❌)
// or two (⚠️ = ⚠ + VS16), so plain padEnd would skew the grid. Measure
// display width for the glyphs the matrix uses; ANSI color codes measure zero.
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
// Summary-line emoji only; table cells use plain numbers and color.
const WIDE_GLYPHS = new Set(['✅', '⏳', '❌']);

export function displayWidth(text: string): number {
  const plain = text.replace(ANSI_PATTERN, '').replace(/\uFE0F/g, '');
  let width = 0;
  for (const char of plain) width += WIDE_GLYPHS.has(char) ? 2 : 1;
  return width;
}

function padDisplay(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

const AWS_QUOTA_HEADER: Record<string, string> = {
  'G and VT': 'G/VT GPUs',
  P: 'P GPUs',
  Standard: 'CPU',
  Inf: 'Inferentia',
  Trn: 'Trainium',
};

function azureQuotaHeader(family: string): string | undefined {
  const lower = family.toLowerCase();
  if (lower === 'total regional low-priority vcpus') return 'Spot vCPUs';
  if (lower === 'total regional vcpus') return 'vCPUs';

  const standardFamily = family.match(/^Standard\s+(.+?)\s+Family vCPUs$/i);
  if (standardFamily) return standardFamily[1];

  const familySuffix = family.match(/^(.+?)\s+Family vCPUs$/i);
  if (familySuffix) return familySuffix[1];

  return undefined;
}

function quotaGroupHeader(family: string): string {
  return AWS_QUOTA_HEADER[family] ?? azureQuotaHeader(family) ?? family;
}

function cellFor(entry: QuotaStatusEntry | undefined): string {
  if (!entry) return chalk.dim('—');
  if (isCurrentStatusEntry(entry)) {
    const amount = entry.currentLimit ?? 0;
    return amount === 0 ? chalk.dim('0') : String(amount);
  }
  if (isLocalOperationStatusEntry(entry)) {
    return BUCKET_COLOR.open((entry.status || 'pending').toLowerCase());
  }
  const bucket = quotaBucket(entry);
  const requestedLimit = entry.requestedLimit ?? 0;
  let amount: string;
  if (
    bucket === 'partial' &&
    entry.grantedLimit !== null &&
    entry.grantedLimit !== undefined
  ) {
    amount = `${entry.grantedLimit}/${requestedLimit}`;
  } else if (bucket === 'approved') {
    amount = String(
      entry.grantedLimit ?? (requestedLimit > 0 ? requestedLimit : ''),
    );
  } else {
    amount = requestedLimit > 0 ? String(requestedLimit) : '';
  }
  return BUCKET_COLOR[bucket](amount);
}

/** One matrix: regions down, quota groups across, one entry per cell. */
function matrixLines(
  entries: QuotaStatusEntry[],
  extraFamilies: string[] = [],
): string[] {
  const familyTotals = new Map<string, number>();
  const families = new Map<string, StatusMatrixFamily>();
  for (const family of extraFamilies) {
    const matchingEntry = entries.find(
      (entry) => matrixFamilyFor(entry).family === family,
    );
    const column = matchingEntry
      ? matrixFamilyFor(matchingEntry)
      : { key: `extra\0${family}`, family, total: 0 };
    families.set(column.key, column);
  }
  const cells = new Map<string, QuotaStatusEntry>();
  for (const entry of entries) {
    const column = matrixFamilyFor(entry);
    const value = statusCellValue(entry);
    familyTotals.set(column.key, (familyTotals.get(column.key) ?? 0) + value);
    const existing = families.get(column.key) ?? column;
    existing.total += value;
    families.set(column.key, existing);
    cells.set(`${entry.region}:${column.key}`, entry);
  }
  const sortedFamilies = [...families.values()].sort(
    (a, b) =>
      (familyTotals.get(b.key) ?? 0) - (familyTotals.get(a.key) ?? 0) ||
      a.family.localeCompare(b.family) ||
      b.total - a.total,
  );
  const regions = [...new Set(entries.map((entry) => entry.region))].sort();

  const headerRow = [
    'REGION',
    ...sortedFamilies.map((family) => quotaGroupHeader(family.family)),
  ];
  const dataRows = regions.map((region) => [
    region,
    ...sortedFamilies.map((family) =>
      cellFor(cells.get(`${region}:${family.key}`)),
    ),
  ]);

  const widths = headerRow.map((_, column) =>
    Math.max(
      displayWidth(headerRow[column]),
      ...dataRows.map((row) => displayWidth(row[column])),
    ),
  );
  const line = (row: string[]): string =>
    row
      .map((cell, column) => padDisplay(cell, widths[column]))
      .join('  ')
      .trimEnd();

  const lines: string[] = [];
  lines.push(chalk.cyan(line(headerRow)));
  for (const row of dataRows) lines.push(line(row));
  return lines;
}

/**
 * Region × quota-group matrix instead of one row per entry: an all-region read
 * returns dozens of entries and flat forms were an unreadable wall. AWS spot
 * and on-demand entries render as separate matrices; other clouds keep their
 * provider quota names as columns. Submitted timestamps, case IDs, provider
 * request IDs, and URLs are --json only.
 */
export function buildStatusMatrixLines(view: QuotaStatusView): string[] {
  const canceledLines = view.canceledTargets.length
    ? [
        '',
        chalk.yellow(
          'CANCELED LOCAL SUBMISSIONS — request manually through the provider',
        ),
        ...view.canceledTargets.map((group) => {
          const target = group[0];
          return `  ${target.region} · ${target.vmType ?? group.map((entry) => entry.resourceName).join(', ')} (${target.spot ? 'spot' : 'on-demand'}) · ${group.map((entry) => entry.resourceName).join(', ')} · operation ${target.operationId}`;
        }),
      ]
    : [];
  const { entries, summary, counts } = view;
  const warnings = view.unavailable.map(
    (entry) =>
      `Unavailable in ${entry.region}: ${entry.resourceName}${entry.message ? ` (${entry.message})` : ''}`,
  );
  if (entries.length === 0)
    return [
      ...warnings,
      ...(canceledLines.length
        ? canceledLines.slice(1)
        : ['No quota requests or current limits found.']),
    ];

  const regions = new Set(entries.map((entry) => entry.region));
  const regionCount = `${regions.size} region${regions.size === 1 ? '' : 's'}`;
  const summaryParts =
    summary !== 'requests'
      ? [
          chalk.yellow('No quota requests'),
          summary === 'zero-current'
            ? chalk.yellow('all visible current limits are 0')
            : chalk.cyan('Current nonzero quota limits'),
          regionCount,
        ]
      : [
          ...(counts.approved
            ? [chalk.green(`✅  ${counts.approved} approved`)]
            : []),
          ...(counts.partial
            ? [chalk.yellow(`⚠️  ${counts.partial} partial`)]
            : []),
          ...(counts.open ? [chalk.yellow(`⏳  ${counts.open} waiting`)] : []),
          ...(counts.denied ? [chalk.red(`❌  ${counts.denied} denied`)] : []),
          regionCount,
        ];

  const lines = [summaryParts.join(' · '), ''];
  view.sections.forEach((section, index) => {
    if (index > 0) lines.push('');
    if (section.label) lines.push(chalk.yellow(section.label));
    lines.push(...matrixLines(section.entries, section.extraFamilies));
  });
  return [...warnings, ...lines, ...canceledLines];
}
