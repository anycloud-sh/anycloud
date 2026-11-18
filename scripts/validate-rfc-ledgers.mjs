#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import eslint from '@eslint/js';
import { parseIntegrationEntrypointOwners } from './repository-policy/integration-entrypoint-owners.mjs';

const SOURCE_DISPOSITION_HEADER = [
  'Legacy source',
  'Owner',
  'Disposition',
  'Replacement or destination',
  'Notes',
];
const VALID_SOURCE_DISPOSITIONS = new Set(['Replace', 'Relocate', 'Retain']);
function inlineCode(value) {
  const trimmed = value.trim();
  return trimmed.startsWith('`') && trimmed.endsWith('`')
    ? trimmed.slice(1, -1)
    : trimmed;
}

export function parseLegacySourceDisposition(markdown) {
  const section = markdown.match(
    /## Legacy source disposition\s*\n([\s\S]*?)(?=\n## |$)/u,
  )?.[1];
  if (!section) {
    throw new Error('RFC 0017 legacy source disposition section is missing');
  }
  const tableLines = section
    .split('\n')
    .filter((line) => line.trim().startsWith('|'));
  if (tableLines.length < 2) {
    throw new Error('RFC 0017 legacy source disposition table is missing');
  }
  const cells = (line) =>
    line
      .trim()
      .slice(1, -1)
      .split('|')
      .map((cell) => cell.trim());
  const header = cells(tableLines[0]);
  if (JSON.stringify(header) !== JSON.stringify(SOURCE_DISPOSITION_HEADER)) {
    throw new Error(
      'RFC 0017 legacy source disposition columns changed unexpectedly',
    );
  }
  return tableLines.slice(2).map((line) => {
    const row = cells(line);
    if (row.length !== SOURCE_DISPOSITION_HEADER.length) {
      throw new Error(`Malformed RFC 0017 source disposition row: ${line}`);
    }
    return {
      source: inlineCode(row[0]),
      owner: row[1],
      disposition: row[2],
      replacement: row[3],
      notes: row[4],
    };
  });
}

export function validateLegacySourceDisposition(markdown, inventory) {
  const rows = parseLegacySourceDisposition(markdown);
  const registeredList = [...inventory.registeredSources];
  const registeredSources = new Set(registeredList);
  const expectedDispositions = inventory.expectedDispositions ?? new Map();
  const errors = [];
  const seen = new Set();

  for (const source of registeredSources) {
    if (registeredList.filter((entry) => entry === source).length !== 1) {
      errors.push(`legacy source registered more than once: ${source}`);
    }
  }

  for (const row of rows) {
    if (seen.has(row.source)) {
      errors.push(`duplicate legacy source disposition: ${row.source}`);
    }
    seen.add(row.source);
    if (!registeredSources.has(row.source)) {
      errors.push(`unregistered legacy source disposition: ${row.source}`);
    }
    if (!VALID_SOURCE_DISPOSITIONS.has(row.disposition)) {
      errors.push(
        `invalid disposition for ${row.source}: ${row.disposition || '(empty)'}`,
      );
    }
    const expected = expectedDispositions.get(row.source);
    if (expected && row.disposition !== expected) {
      errors.push(
        `${row.source} is registered as ${expected}, found ${row.disposition}`,
      );
    }
    if (!row.owner || !row.replacement || !row.notes) {
      errors.push(
        `${row.source || '(empty source)'} must name its owner, replacement or destination, and rationale`,
      );
    }
  }
  for (const source of registeredSources) {
    if (!seen.has(source)) {
      errors.push(`missing legacy source disposition: ${source}`);
    }
  }
  return errors;
}

const ENFORCEMENT_LAYERS = new Set([
  'type',
  'lint',
  'script',
  'graph',
  'runtime',
  'test',
  'review',
]);

/**
 * Reads the enforcement annotation on each numbered invariant. An invariant
 * that names a mechanism has to name one that exists, so a rule cannot claim
 * enforcement that was never wired. The invariant heading varies by RFC
 * (`Core invariants`, `Required invariants`), so callers may name it.
 */
export function parseEnforcementLedger(markdown, options = {}) {
  const heading = options.heading ?? 'Core invariants';
  const section = markdown.match(
    new RegExp(`## ${heading}\\s*\\n([\\s\\S]*?)(?=\\n## )`, 'u'),
  )?.[1];
  if (!section) throw new Error(`\`## ${heading}\` section is missing`);

  // Annotations may wrap: they open with `_Enforcement: ` and run to the line
  // whose last character is the closing underscore.
  const entries = [];
  let current;
  let pending;
  for (const line of section.split('\n')) {
    const numbered = line.match(/^(\d+)\. /u);
    if (numbered) {
      current = { number: Number(numbered[1]), annotation: undefined };
      entries.push(current);
      pending = undefined;
      continue;
    }
    const opened = line.match(/^\s*_Enforcement: (.*)$/u);
    if (opened && current && current.annotation === undefined) {
      pending = opened[1];
    } else if (pending !== undefined) {
      pending += ` ${line.trim()}`;
    }
    if (pending !== undefined && pending.endsWith('_') && current) {
      current.annotation = pending.slice(0, -1);
      pending = undefined;
    }
  }
  return entries;
}

/**
 * Invariant 10 requires target-class facts in a `satisfies`-checked table per
 * family. "Every family" is only auditable if the families are enumerated, so
 * the annotation must name them and the list must equal the multi-target
 * families derived from the spec tree. A family running one target declares
 * that substrate instead and is exempt by the invariant's own last sentence.
 *
 * This catches a new multi-target family landing without revisiting invariant
 * 10. It does not check that a listed family's table is correct — that is what
 * each family's typed exhaustiveness test is for.
 */
export function validateClassTableScope(markdown, contracts) {
  const members = new Map();
  for (const { family, name } of contracts) {
    const seen = members.get(family) ?? new Set();
    seen.add(name);
    members.set(family, seen);
  }
  const expected = [...members]
    .filter(([, names]) => names.size > 1)
    .map(([family]) => family)
    .sort();

  const claimed = markdown.match(
    /class tables cover every multi-target family: ([^;_]+)/u,
  )?.[1];
  if (!claimed) {
    return [
      'core invariant 10 does not enumerate the families its class-table claim covers',
    ];
  }
  const listed = claimed
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .sort();
  if (listed.join(', ') === expected.join(', ')) return [];
  return [
    `core invariant 10 claims class tables for ${listed.join(', ') || '(none)'}, but the multi-target families are ${expected.join(', ')}`,
  ];
}

export function validateEnforcementLedger(markdown, inventory, options = {}) {
  const entryLabel = options.entryLabel ?? 'core invariant';
  const {
    lintRules,
    wiredLintRules,
    paths,
    graphRules = new Set(),
    policyScripts = new Set(),
    wiredGraphRules = new Set(),
    wiredPolicyScripts = new Set(),
  } = inventory;
  const entries = parseEnforcementLedger(markdown, options);
  const errors = [];
  if (entries.length === 0) errors.push(`no ${entryLabel}s were found`);

  for (const { number, annotation } of entries) {
    const label = `${entryLabel} ${number}`;
    if (!annotation) {
      errors.push(`${label} has no enforcement annotation`);
      continue;
    }
    const [tag] = annotation.split(' — ');
    // Split at the first colon only: graph rule names carry their own
    // colons (graph:module-ownership:slurp.aws.ts).
    const separatorIndex = tag.indexOf(':');
    const layer = separatorIndex === -1 ? tag : tag.slice(0, separatorIndex);
    const rule =
      separatorIndex === -1 ? undefined : tag.slice(separatorIndex + 1);
    if (!ENFORCEMENT_LAYERS.has(layer)) {
      errors.push(`${label} names an unknown enforcement layer: ${layer}`);
      continue;
    }
    if (!annotation.includes(' — ')) {
      errors.push(`${label} does not explain its ${layer} enforcement`);
    }
    if (layer === 'lint') {
      if (!rule) errors.push(`${label} does not name a lint rule`);
      else if (!lintRules.has(rule)) {
        errors.push(`${label} names a lint rule that does not exist: ${rule}`);
      } else if (!wiredLintRules.has(rule)) {
        errors.push(`${label} names a lint rule that is not wired: ${rule}`);
      }
    } else if (layer === 'script') {
      if (!rule) errors.push(`${label} does not name a policy script`);
      else if (!policyScripts.has(rule)) {
        errors.push(
          `${label} names a policy script that does not exist: ${rule}`,
        );
      } else if (!wiredPolicyScripts.has(rule)) {
        errors.push(
          `${label} names a policy script that is not wired: ${rule}`,
        );
      }
    } else if (layer === 'graph') {
      if (!rule) errors.push(`${label} does not name a graph rule`);
      else if (!graphRules.has(rule)) {
        errors.push(`${label} names a graph rule that does not exist: ${rule}`);
      } else if (!wiredGraphRules.has(rule)) {
        errors.push(`${label} names a graph rule that is not wired: ${rule}`);
      }
    } else if (rule) {
      errors.push(`${label} may not qualify a ${layer} enforcement layer`);
    }
    // Secondary mechanism references in the explanation are validated like
    // the primary tag: an annotation must not name a mechanism that does
    // not exist, wherever in the sentence it names it.
    for (const secondary of annotation.matchAll(
      /\b(lint|graph|script):([A-Za-z0-9_./:-]+)/gu,
    )) {
      if (secondary.index === 0) continue;
      const [, secondaryLayer, rawRule] = secondary;
      const secondaryRule = rawRule.replace(/\.$/u, '');
      const known =
        secondaryLayer === 'lint'
          ? lintRules
          : secondaryLayer === 'graph'
            ? graphRules
            : policyScripts;
      const wired =
        secondaryLayer === 'lint'
          ? wiredLintRules
          : secondaryLayer === 'graph'
            ? wiredGraphRules
            : wiredPolicyScripts;
      if (!known.has(secondaryRule)) {
        errors.push(
          `${label} references a ${secondaryLayer} mechanism that does not exist: ${secondaryRule}`,
        );
      } else if (!wired.has(secondaryRule)) {
        errors.push(
          `${label} references a ${secondaryLayer} mechanism that is not wired: ${secondaryRule}`,
        );
      }
    }
    for (const [, referenced] of annotation.matchAll(
      /`([\w./-]+\.(?:ts|mjs))`/gu,
    )) {
      if (!paths.has(referenced)) {
        errors.push(`${label} names a missing file: ${referenced}`);
      }
    }
  }
  return errors;
}

function entryLayer(entry) {
  return entry.annotation?.split(' — ')[0]?.split(':')[0];
}

const WIRING_CHECKED_LAYERS = new Set(['graph', 'lint', 'script']);

/**
 * The rollup an annotated RFC must carry, verbatim. It distinguishes what the
 * validator actually proved: `lint:`, `script:`, and `graph:` mechanisms are checked to
 * exist and be wired, while `type`, `runtime`, and `test` are cited with only
 * their named paths checked — a flat "N of M enforced" lets the weaker claim
 * borrow the stronger one's credibility.
 */
export function formatRollup(entries) {
  const review = entries.filter((entry) => entryLayer(entry) === 'review');
  const wired = entries.filter((entry) =>
    WIRING_CHECKED_LAYERS.has(entryLayer(entry)),
  ).length;
  const cited = entries.length - wired - review.length;
  const base = `**${wired} of ${entries.length} verified wired, ${cited} cited, and ${review.length} resting on review**`;
  if (review.length === 0) return `${base}.`;
  const numbers = review.map((entry) => entry.number);
  if (numbers.length === 1) return `${base}: invariant ${numbers[0]}.`;
  const list = `${numbers.slice(0, -1).join(', ')}${numbers.length > 2 ? ',' : ''} and ${numbers.at(-1)}`;
  return `${base}: invariants ${list}.`;
}

/**
 * The rollup sentence is part of the ledger: a hand-maintained count drifts,
 * and the number the RFC tells readers to watch has to be the computed one.
 * Prose wrapping is layout, not content, so the comparison collapses runs of
 * whitespace on both sides.
 */
export function validateEnforcementRollup(markdown, options = {}) {
  const expected = formatRollup(parseEnforcementLedger(markdown, options));
  const collapse = (value) => value.replaceAll(/\s+/gu, ' ');
  return collapse(markdown).includes(collapse(expected))
    ? []
    : [`rollup sentence must read: ${expected}`];
}

const SCENARIO_HEADER = ['ID', 'Scenario', 'Required result', 'Coverage'];

export function parseScenarioTable(markdown) {
  const section = markdown.match(
    /## Acceptance scenarios\s*\n([\s\S]*?)(?=\n## |$)/u,
  )?.[1];
  if (!section) return undefined;
  const tableLines = section
    .split('\n')
    .filter((line) => line.trim().startsWith('|'));
  if (tableLines.length < 3) return undefined;
  const cells = (line) =>
    line
      .trim()
      .slice(1, -1)
      .split('|')
      .map((cell) => cell.trim());
  return { header: cells(tableLines[0]), rows: tableLines.slice(2).map(cells) };
}

/**
 * Every acceptance scenario of a registered RFC names the test that holds it,
 * or confesses review/deferral. The token convention
 * (`NNNN/S<k>` embedded in a test title) keeps the check a grep: no runner
 * integration, and a scenario cannot borrow another row's or another RFC's
 * test.
 */
export function validateScenarioCoverage(
  label,
  rfcNumber,
  markdown,
  inventory,
) {
  const { testTokens, rfcNumbers, required } = inventory;
  const errors = [];
  const table = parseScenarioTable(markdown);
  if (!table) {
    if (required) errors.push(`${label} has no acceptance-scenario table`);
    return errors;
  }
  if (JSON.stringify(table.header) !== JSON.stringify(SCENARIO_HEADER)) {
    if (required) {
      errors.push(`${label} scenario table must carry a Coverage column`);
    }
    return errors;
  }
  for (const row of table.rows) {
    if (row.length !== SCENARIO_HEADER.length) {
      errors.push(`${label} has a malformed scenario row: ${row.join(' | ')}`);
      continue;
    }
    const [id, , , coverage] = row;
    const rowLabel = `${label} scenario ${id}`;
    const [tagPart, ...reason] = coverage.split(' — ');
    const separator = tagPart.indexOf(':');
    const tag = separator === -1 ? tagPart : tagPart.slice(0, separator);
    const value = separator === -1 ? undefined : tagPart.slice(separator + 1);
    if (tag === 'test') {
      const expected = `${rfcNumber}/${id}`;
      if (value !== expected) {
        errors.push(`${rowLabel} must cite test:${expected}, found ${tagPart}`);
      } else if (!testTokens.has(expected)) {
        errors.push(
          `${rowLabel} cites ${expected}, but no test carries that token`,
        );
      }
    } else if (tag === 'review') {
      if (reason.join('').trim().length === 0) {
        errors.push(`${rowLabel} rests on review without a reason`);
      }
    } else if (tag === 'deferred') {
      if (!value || !rfcNumbers.has(value)) {
        errors.push(
          `${rowLabel} defers to an RFC that does not exist: ${value ?? '(none)'}`,
        );
      }
    } else {
      errors.push(`${rowLabel} has an unknown coverage tag: ${tag}`);
    }
  }
  return errors;
}

/**
 * Invariant 6: unsupported membership is explicit with a reason, so a target
 * with no spec reads as a decision rather than an oversight.
 */
export function parseMembershipMatrix(markdown) {
  const matrices = [];
  const lines = markdown.split('\n');
  for (const [index, line] of lines.entries()) {
    const header = line.match(/^\| ([A-Za-z][\w -]*) concern\s*\|/u);
    if (!header) continue;
    const columns = line
      .trim()
      .slice(1, -1)
      .split('|')
      .map((cell) => cell.trim());
    const rows = [];
    for (const row of lines.slice(index + 2)) {
      if (!row.trim().startsWith('|')) break;
      rows.push(
        row
          .trim()
          .slice(1, -1)
          .split('|')
          .map((cell) => cell.trim()),
      );
    }
    // Column 0 is the concern and column 1 is its kind; targets follow.
    matrices.push({ family: header[1], rows, targets: columns.slice(2) });
  }
  return matrices;
}

const MEMBERSHIP_VALUES = new Set(['Required', 'Unsupported', 'Evaluate']);

export function validateMembershipMatrices(markdown, familyTargets) {
  const errors = [];
  for (const { family, rows, targets } of parseMembershipMatrix(markdown)) {
    const covered = familyTargets.get(family.toLowerCase()) ?? new Set();
    const unsupported = new Map();
    for (const row of rows) {
      const concern = row[0];
      row.slice(2).forEach((cell, index) => {
        const target = targets[index] ?? `column ${String(index)}`;
        const [value, ...reason] = cell.split(' — ');
        if (!MEMBERSHIP_VALUES.has(value)) {
          errors.push(
            `${family} membership for ${target} / ${concern} is not Required, Unsupported, or Evaluate: ${cell}`,
          );
          return;
        }
        if (value !== 'Required' && reason.join(' — ').length === 0) {
          errors.push(
            `${family} membership marks ${target} / ${concern} ${value} without a reason`,
          );
        }
        if (value === 'Unsupported') {
          unsupported.set(target.toLowerCase(), concern);
        }
      });
    }
    // A target that ships a member cannot also be declared unsupported.
    for (const target of covered) {
      const concern = unsupported.get(target);
      if (concern) {
        errors.push(
          `${family} has a ${target} member while the matrix marks it unsupported for ${concern}`,
        );
      }
    }
  }
  return errors;
}

function specFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return specFiles(path);
    return entry.isFile() && entry.name.endsWith('.spec.ts') ? [path] : [];
  });
}

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return entry.isFile() ? [path] : [];
  });
}

function enforcementInventory(projectRoot, markdown, options = {}) {
  const pathRoots = options.pathRoots ?? [''];
  const plugin = readFileSync(
    join(projectRoot, 'eslint-plugin-local/index.mjs'),
    'utf8',
  );
  const config = readFileSync(join(projectRoot, 'eslint.config.mjs'), 'utf8');
  const lintRules = new Set([
    ...Object.keys(eslint.configs.all.rules),
    ...[...plugin.matchAll(/^\s{4}'([a-z0-9-]+)':/gmu)].map((m) => m[1]),
  ]);
  const wiredLintRules = new Set(
    [...config.matchAll(/^\s+'((?:local\/)?[a-z0-9-]+)':/gmu)].map((m) =>
      m[1].replace(/^local\//u, ''),
    ),
  );
  const paths = new Set();
  for (const [, referenced] of markdown.matchAll(
    /`([\w./-]+\.(?:ts|mjs))`/gu,
  )) {
    for (const root of pathRoots) {
      if (existsSync(join(projectRoot, root, referenced))) {
        paths.add(referenced);
      }
    }
  }
  // A policy script is wired when a package.json script invokes it; the same
  // exists-and-wired standard lint rules get.
  const packageJson = JSON.parse(
    readFileSync(join(projectRoot, 'package.json'), 'utf8'),
  );
  const scriptCommands = Object.values(packageJson.scripts ?? {}).join('\n');
  const policyScripts = new Set(
    filesUnder(join(projectRoot, 'scripts'))
      .map((path) => path.slice(projectRoot.length + 1))
      .filter((path) => /\.m?js$/u.test(path)),
  );
  const wiredPolicyScripts = new Set(
    [...policyScripts].filter((path) => scriptCommands.includes(path)),
  );
  // Graph rules are read textually, like the lint rules above: only
  // statically named rules are citable, so a generated rule name must be
  // promoted to a literal before an RFC can claim it.
  const graphConfig = readFileSync(
    join(projectRoot, '.dependency-cruiser.cjs'),
    'utf8',
  );
  const graphRules = new Set(
    [...graphConfig.matchAll(/^\s*name: '([a-z0-9:.-]+)',$/gmu)].map(
      (m) => m[1],
    ),
  );
  const wiredGraphRules = scriptCommands.includes('.dependency-cruiser.cjs')
    ? graphRules
    : new Set();
  return {
    graphRules,
    lintRules,
    paths,
    policyScripts,
    wiredGraphRules,
    wiredLintRules,
    wiredPolicyScripts,
  };
}

/**
 * RFCs whose acceptance scenarios must name their coverage (RFC 0025).
 * Unregistered RFCs are still validated whenever their
 * scenario table already carries the Coverage column (voluntary adoption).
 */
const SCENARIO_GATED_RFCS = [
  {
    path: 'rfcs/0040-targeted-harness-mutation-testing.md',
    label: 'RFC 0040',
  },
  {
    path: 'rfcs/0036-job-deployment-configuration-authority.md',
    label: 'RFC 0036',
  },
  {
    path: 'rfcs/0046-slurm-jobs-on-an-attached-cluster.md',
    label: 'RFC 0046',
  },
  {
    path: 'rfcs/0047-credential-scope-and-least-privilege-provisioning.md',
    label: 'RFC 0047',
  },
  {
    path: 'rfcs/0051-credential-quota-wait-coordination.md',
    label: 'RFC 0051',
  },
];

/**
 * Every RFC that states invariants annotates them (RFC 0025). The heading and
 * entry label vary by document; path roots resolve relative mechanism
 * references named in annotations.
 */
const ANNOTATED_RFCS = [
  {
    path: 'rfcs/0040-targeted-harness-mutation-testing.md',
    label: 'RFC 0040',
    heading: 'Required invariants',
    entryLabel: 'required invariant',
    pathRoots: [''],
  },
  {
    path: 'rfcs/0017-constrained-vitest-e2e.md',
    label: 'RFC 0017',
    heading: 'Core invariants',
    entryLabel: 'core invariant',
    pathRoots: ['', 'test/integration/e2e'],
  },
  {
    path: 'rfcs/0025-enforcement-ledgers.md',
    label: 'RFC 0025',
    heading: 'Required invariants',
    entryLabel: 'required invariant',
    pathRoots: [''],
  },
  {
    path: 'rfcs/0027-cloud-credential-acquisition.md',
    label: 'RFC 0027',
    heading: 'Required invariants',
    entryLabel: 'required invariant',
    pathRoots: [''],
  },
  {
    path: 'rfcs/0028-module-graph-enforcement.md',
    label: 'RFC 0028',
    heading: 'Required invariants',
    entryLabel: 'required invariant',
    pathRoots: [''],
  },
  {
    path: 'rfcs/0036-job-deployment-configuration-authority.md',
    label: 'RFC 0036',
    heading: 'Required invariants',
    entryLabel: 'required invariant',
    pathRoots: [''],
  },
  {
    path: 'rfcs/0046-slurm-jobs-on-an-attached-cluster.md',
    label: 'RFC 0046',
    heading: 'Required invariants',
    entryLabel: 'required invariant',
    pathRoots: [''],
  },
  {
    path: 'rfcs/0047-credential-scope-and-least-privilege-provisioning.md',
    label: 'RFC 0047',
    heading: 'Required invariants',
    entryLabel: 'required invariant',
    pathRoots: [''],
  },
  {
    path: 'rfcs/0051-credential-quota-wait-coordination.md',
    label: 'RFC 0051',
    heading: 'Required invariants',
    entryLabel: 'required invariant',
    pathRoots: [''],
  },
];

export function validateRfcLedgers(projectRoot) {
  const rfcPath = join(projectRoot, 'rfcs/0017-constrained-vitest-e2e.md');
  const specsRoot = join(projectRoot, 'test/integration/e2e/specs');
  const specs = specFiles(specsRoot);
  const contracts = specs
    .filter((specPath) => specPath.includes('/specs/contracts/'))
    .map((specPath) => ({
      family: basename(dirname(specPath)),
      name: basename(specPath).replace(/\.spec\.ts$/u, ''),
    }));
  const ownerSource = readFileSync(
    join(
      projectRoot,
      'scripts/repository-policy/integration-entrypoint-owners.mjs',
    ),
    'utf8',
  );
  const owners = parseIntegrationEntrypointOwners(ownerSource);
  const {
    destructiveBackstopTests = [],
    shellIntegrationTests = [],
    shellNativeQualificationTests = [],
  } = owners;
  const markdown = readFileSync(rfcPath, 'utf8');
  const errors = validateClassTableScope(markdown, contracts);
  errors.push(...owners.errors);
  const expectedDispositions = new Map([
    ...shellNativeQualificationTests.map((path) => [path, 'Retain']),
    ...destructiveBackstopTests.map((path) => [path, 'Retain']),
  ]);
  errors.push(
    ...validateLegacySourceDisposition(markdown, {
      expectedDispositions,
      registeredSources: shellIntegrationTests,
    }),
  );
  if (errors.length > 0) {
    throw new Error(
      `RFC 0017 source disposition is invalid:\n- ${errors.join('\n- ')}`,
    );
  }

  const familyTargets = new Map();
  for (const { family, name } of contracts) {
    const key = family.replace(/-.*$/u, '');
    const target = name.replace(new RegExp(`-${family}.*$`, 'u'), '');
    familyTargets.set(
      key,
      (familyTargets.get(key) ?? new Set()).add(target.toLowerCase()),
    );
  }
  const membershipErrors = validateMembershipMatrices(markdown, familyTargets);
  if (membershipErrors.length > 0) {
    throw new Error(
      `RFC 0017 membership matrix is invalid:\n- ${membershipErrors.join('\n- ')}`,
    );
  }

  const enforcement = [];
  for (const rfc of ANNOTATED_RFCS) {
    const rfcMarkdown = readFileSync(join(projectRoot, rfc.path), 'utf8');
    const options = { entryLabel: rfc.entryLabel, heading: rfc.heading };
    const enforcementErrors = [
      ...validateEnforcementLedger(
        rfcMarkdown,
        enforcementInventory(projectRoot, rfcMarkdown, {
          pathRoots: rfc.pathRoots,
        }),
        options,
      ),
      ...validateEnforcementRollup(rfcMarkdown, options),
    ];
    if (enforcementErrors.length > 0) {
      throw new Error(
        `${rfc.label} enforcement ledger is invalid:\n- ${enforcementErrors.join('\n- ')}`,
      );
    }
    enforcement.push({
      label: rfc.label,
      rollup: formatRollup(parseEnforcementLedger(rfcMarkdown, options)),
    });
  }

  const testTokens = new Set();
  for (const path of filesUnder(join(projectRoot, 'test'))) {
    if (!/\.(?:ts|mjs|sh)$/u.test(path)) continue;
    for (const [token] of readFileSync(path, 'utf8').matchAll(
      /\b\d{4}\/S\d+\b/gu,
    )) {
      testTokens.add(token);
    }
  }
  const rfcFiles = readdirSync(join(projectRoot, 'rfcs')).filter((name) =>
    /^\d{4}-.*\.md$/u.test(name),
  );
  const rfcNumbers = new Set(rfcFiles.map((name) => name.slice(0, 4)));
  const registeredScenarioPaths = new Set(
    SCENARIO_GATED_RFCS.map((rfc) => rfc.path),
  );
  const scenarioRfcs = [
    ...SCENARIO_GATED_RFCS,
    ...rfcFiles
      .map((name) => ({
        path: `rfcs/${name}`,
        label: `RFC ${name.slice(0, 4)}`,
      }))
      .filter((rfc) => !registeredScenarioPaths.has(rfc.path)),
  ];
  for (const rfc of scenarioRfcs) {
    const rfcMarkdown = readFileSync(join(projectRoot, rfc.path), 'utf8');
    // A superseded RFC is a historical record; its scenarios bind no tests.
    if (/^> Status: Superseded\b/mu.test(rfcMarkdown)) continue;
    const scenarioErrors = validateScenarioCoverage(
      rfc.label,
      basename(rfc.path).slice(0, 4),
      rfcMarkdown,
      {
        testTokens,
        rfcNumbers,
        required: registeredScenarioPaths.has(rfc.path),
      },
    );
    if (scenarioErrors.length > 0) {
      throw new Error(
        `${rfc.label} scenario coverage is invalid:\n- ${scenarioErrors.join('\n- ')}`,
      );
    }
  }

  return { contracts: contracts.length, enforcement };
}

const defaultProjectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 3) {
      throw new Error('usage: validate-rfc-ledgers.mjs [repository-root]');
    }
    const projectRoot = process.argv[2]
      ? resolve(process.argv[2])
      : defaultProjectRoot;
    const { contracts, enforcement } = validateRfcLedgers(projectRoot);
    console.log(
      `Validated RFC 0017 source disposition and class tables for ${contracts} constrained contracts.`,
    );
    for (const { label, rollup } of enforcement) {
      console.log(`${label} enforcement: ${rollup.replaceAll('**', '')}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
