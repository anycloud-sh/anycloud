// Prints the Runtime layers, E2E and API contract sections CONTRIBUTING.md
// requires: the RFC 0044 onion layer and substrate of each changed runtime
// file, the end-to-end members a change touches, the member runs it needs, and
// the OpenAPI changes (see openapi-diff.ts). Run through tsx (`yarn pr:sections [--base <ref>] [--head <ref>]`).

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { OPENAPI_PATH, renderOpenApi } from './generate-openapi.js';
import { renderOpenApiDiff } from './openapi-diff.js';

export const LAYERS = [
  '1 Surface',
  '2 Records',
  '3 Outcome policy',
  '4 Contracts',
  '5 Admission',
  '6 Loop',
  '7 Execution',
  '8 Capacity',
];
const SUBSTRATES = ['shared', 'vm', 'slurm'];

/** Parses `<columns> <regex>` lines, where `S/` abbreviates `src/api/services/`. */
const table = (text: string) =>
  text
    .trim()
    .split('\n')
    .map((line) => {
      const fields = line.trim().split(/\s+/);
      const pattern = fields.pop()!.replace('S/', 'src/api/services/');
      return [new RegExp(`^(?:${pattern})`), ...fields] as const;
    });

/**
 * Path → layer and substrates (`-` for none); the first match wins. Layer 0
 * is outside the runtime layers. A unit test keeps every module under
 * `src/api/services/` mapped.
 */
export const LAYER_MAP = table(String.raw`
  0  -          src/api/((composition|server|config|restore-state|system-release-hook|host-step|runtime-artifacts)\.ts$|middleware/)
  0  -          src/shared/api-contract/openapi\.generated\.json$
  0  -          S/(api-|first-backup|e2e-access-handoff|notif|telemetry|update-notifications|system-release|cluster-(installer|self|store|hosted-pools)|kubernetes/|cloud-account|credential|role-connection|secret|database-domain|bucket-|storage-token-|catalog|logger|redact|test-identity|vm-release-notifications|http-shutdown|persistence|monitor\.|supervisor|task\.|entities|codes)
  4  slurm      S/slurm/classify
  5  slurm      S/slurm/(.*admission|preflight)
  7  slurm      S/slurm/
  1  slurm      S/slurm-clusters-domain\.ts$
  2  slurm      S/repositories/slurm-clusters\.ts$
  2  shared     src/shared/workload\.ts$
  7  vm         src/shared/(ssh-runtime|docker-)
  1  shared     src/(cli|shared)/|src/api/(rpc|routes)/|python/
  1  shared     S/(clusters-domain|cluster-delete-report|cluster-errors|workload-management-domain|service-upgrade-domain|spend-controls-domain|quota-domain)\.ts$
  3  shared     S/(retry-backoff|repositories/workload-outcomes)\.ts$
  4  shared     S/(spend-controls|spend-controls-store|request-budget)\.ts$
  5  shared     S/job-spec-admission\.ts$
  4  vm         S/cost-calculation/
  2  vm         S/repositories/(billing|workload-spend)\.ts$
  8  vm         S/repositories/provisioning-attempts\.ts$
  2  shared     S/(repositories/|(workload-record|workload-event-metadata|container-spec)\.ts$)|migrations/
  5  vm         S/container-image\.ts$
  7  vm         S/(runtime-secrets|dns-publication|gpu-fabric)\.ts$
  5  vm         S/(workload-admission-|quota/|workload-bucket-validation|compute-validation)
  7  vm         S/(workload-workflows/vm-host-startup|job/|serve/|serve\.ts|host-runtime/|vm-(exec|initializer|startup-script|runtime-storage)|job-host|docker|containerd-transfer|resource-disk-store|image-manifest|container-health|rclone-config|workload-storage|service-storage-renewal|live-secret-files)
  6  vm         S/(workload-workflows/|reconciliation/|workload-reconciler|workload-work-registry|workload-cleanup|workload-operation-helpers)
  8  vm         S/launch-targets
  8  vm         S/(compute-candidates|optimizer|runtime-placement|candidate-preflight-cache)
  8  vm         S/(gateways/|installation-sweep|self-delete|provider-clients/|network|firewall-plan|cloud-(config|endpoints|resource-scope)|cloudflare-ips|azure-client-options)
  8  vm         S/provisioning-failure
  8  vm         S/(vm-provisioner|vm-compute|status-vm)
`).map(([pattern, layer, substrates]) => ({
  pattern,
  layer: Number(layer),
  substrates: substrates === '-' ? [] : substrates.split(','),
}));

/** One changed file: git status letter (A, M, D or R), path, old path for a rename, and line counts. */
export interface FileChange {
  status: string;
  path: string;
  from?: string;
  added: number;
  deleted: number;
}
const MARKS: Record<string, string> = { A: '🟢', M: '🟡', D: '🔴', R: '🔵' };
const totals = (files: FileChange[]) =>
  `+${files.reduce((n, f) => n + f.added, 0)}/−${files.reduce((n, f) => n + f.deleted, 0)}`;
const short = (path: string) =>
  `${path.startsWith('migrations/') ? '🗃️ ' : ''}\`${path.replace(/^src\/api\/services\/|^src\/|^migrations\/|^test\/integration\/e2e\/(specs\/(contracts\/)?|qualification\/assertion-maps\/)?/, '')}\``;
const label = (c: FileChange) =>
  `${MARKS[c.status] ?? '🟡'} ${short(c.path)}${c.from ? ` from ${short(c.from)}` : ''} ${totals([c])}`;
const cell = (files: FileChange[] = []) =>
  files.map(label).join('<br>') +
  (files.length > 1 ? `<br>**${totals(files)}**` : '');
const isRuntime = (path: string) => /^(src|python|migrations)\//.test(path);
export const layerOf = (path: string) =>
  LAYER_MAP.find(({ pattern }) => pattern.test(path));

export function renderLayers(changes: FileChange[]): string {
  const runtime = changes.filter((c) => isRuntime(c.path));
  if (!runtime.length) return '### Runtime layers\n\nNo runtime files changed.';
  const cells = new Map<string, FileChange[]>();
  const outside: string[] = [];
  const unmapped: string[] = [];
  for (const change of runtime) {
    const entry = layerOf(change.path);
    if (!entry) unmapped.push(label(change));
    else if (entry.layer === 0) outside.push(label(change));
    for (const substrate of entry?.substrates ?? []) {
      const key = `${entry!.layer}:${substrate}`;
      cells.set(key, [...(cells.get(key) ?? []), change]);
    }
  }
  const touched = (layer: number) =>
    SUBSTRATES.some((s) => cells.has(`${layer}:${s}`));
  const untouched = LAYERS.filter((_, i) => !touched(i + 1));
  return [
    '### Runtime layers',
    '',
    '| Layer | Shared | VM host | Slurm |',
    '| --- | --- | --- | --- |',
    ...LAYERS.map(
      (name, i) =>
        `| ${name} | ${SUBSTRATES.map((s) => cell(cells.get(`${i + 1}:${s}`))).join(' | ')} |`,
    ),
    '',
    '🟢 added · 🟡 modified · 🔴 deleted · 🔵 renamed · 🗃️ migration · +added/−deleted lines',
    '',
    `Untouched: ${untouched.length ? untouched.join(', ') : 'none'}.`,
    ...(outside.length
      ? ['', `Outside the runtime layers: ${outside.join(', ')}.`]
      : []),
    ...(unmapped.length
      ? ['', `Not in \`LAYER_MAP\`, so classify them: ${unmapped.join(', ')}.`]
      : []),
  ].join('\n');
}

const SPECS = 'test/integration/e2e/specs/';
const MAPS = 'test/integration/e2e/qualification/assertion-maps/';
const E2E_FILE =
  /^(test\/integration\/e2e\/|test\/docker\/(?!Dockerfile\.arm64-only|registry-range)|\.github\/workflows\/(integration|e2e-[\w-]+)\.yml$)/;
/** Members exercising each substrate column; layer reach requires only the free ones. */
const SUBSTRATE_MEMBERS: Record<string, RegExp> = {
  shared: /./,
  vm: /^(local|aws|gcp|azure|lambda)-/,
  slurm: /^slurm-/,
};
/**
 * Runtime code whose paid members free reach never requires, and those
 * members; `$1` is the first group. Secret delivery needs the private-Git
 * clone through the `github` Secret.
 */
const PAID_CODE = table(String.raw`
  ^$1-                       S/(?:gateways|provider-clients)/(aws|gcp|azure|lambda)
  ^e2e-cluster-cloud$        S/(cluster-installer|system-release/)
  -runtime-secrets$          S/(docker|runtime-secrets|live-secret-files)\.ts$|src/api/rpc/secrets\.ts$
`).map(([pattern, members]) => ({ pattern, members }));
/**
 * Harness only paid members run, so free reach never covers it. The members
 * column (matched against `<family>/<member>`) narrows import reach; `$1` is
 * the first group.
 */
const PAID_HARNESS = table(String.raw`
  -spot-request-cleanup$             test/integration/e2e/internal/transports/job-spot
  -mace-full-pull$                   test/integration/e2e/internal/transports/job-mace
  ^dedicated-job/$1-                 test/integration/e2e/internal/transports/job-(aws|gcp|azure)-
  ^dedicated-job/                    test/integration/e2e/internal/(targets|transports)/(public-cloud-job|job-cloud-session)
  /(aws|gcp|azure|lambda)-           test/integration/e2e/internal/transports/public-cloud-vm-host-presence
  ^persistent-vm                     test/integration/e2e/internal/(targets|transports)/public-cloud-vm(\.ts$|-host-deletion)
  ^(serve|gpu-serve|serve-upgrade)/  test/integration/e2e/internal/(targets|transports)/(public-cloud-serve|service-dns)
`).map(([pattern, members]) => ({ pattern, members }));
/** Composition roots import every harness module, so they do not carry reach. */
const ROOTS = new Set([
  'test/integration/e2e/fixture.ts',
  'test/integration/e2e/internal/context.ts',
]);
/** Harness modules the composition root injects → members, matched against `<family>/<member>`. */
const HARNESS_MEMBERS = table(String.raw`
  /e2e-cluster-local$                          test/integration/e2e/internal/(contracts/cluster-local|substrates/local-cluster/)
  /e2e-cluster-cloud$                          test/integration/e2e/internal/(contracts/cluster-cloud|substrates/cloud-cluster/)
  /hosted-api-access-policy$                   test/integration/e2e/internal/api-auth\.ts$
  -bucket-access-denied$                       test/integration/e2e/internal/bucket-access-denied\.ts$
  ^storage-tokens/                             test/integration/e2e/internal/(contracts|transports)/storage-tokens\.ts$
  ^persistent-vm                               test/integration/e2e/internal/persistent-vm-submission\.ts$
  /(billing-settlement|long-history-responsiveness)$ test/integration/e2e/internal/read-models/
  ^persistent-vm/                              test/integration/e2e/internal/contracts/persistent-vm\.ts$
  ^persistent-vm-host-loss/                    test/integration/e2e/internal/contracts/persistent-vm-host-loss\.ts$
  ^serve/                                      test/integration/e2e/internal/contracts/serve-baseline\.ts$
  ^serve-local-recovery/                       test/integration/e2e/internal/contracts/serve-local-recovery\.ts$
  ^serve-upgrade/                              test/integration/e2e/internal/contracts/serve-upgrade\.ts$
  ^gpu-serve/                                  test/integration/e2e/internal/contracts/serve-gpu\.ts$
  ^dedicated-job/                              test/integration/e2e/internal/contracts/dedicated-job\.ts$
  ^(serve|gpu-serve|serve-upgrade|serve-local-recovery)/ test/integration/e2e/internal/service-cleanup\.ts$
  -mace-full-pull$                             test/docker/(Dockerfile\.mace|requirements\.mace)
  /e2e-cluster-cloud$                          test/integration/e2e/internal/kubernetes-constants\.ts$
  .                                            test/integration/e2e/internal/diagnostics\.ts$
  /local-                                      test/integration/e2e/internal/(targets|transports)/local-smolvm-
  ^dedicated-job/(aws|gcp|azure|lambda)-        test/integration/e2e/internal/(targets|transports)/public-cloud-job
  ^(serve|gpu-serve|serve-upgrade)/(aws|gcp|azure|lambda)- test/integration/e2e/internal/(targets|transports)/public-cloud-serve
  ^persistent-vm[^/]*/(aws|gcp|azure|lambda)-   test/integration/e2e/internal/(targets|transports)/public-cloud-vm(\.ts$|-host-deletion)
`).map(([pattern, members]) => ({ pattern, members: new RegExp(members) }));

/** The repository at one ref, or the working tree. */
export interface Tree {
  files: string[];
  read(path: string): string;
}
const memberOf = (path: string) => basename(path, '.spec.ts');
const isSpec = (path: string) =>
  path.startsWith(SPECS) && path.endsWith('.spec.ts');

/** Members each e2e file reaches through relative imports, quoted file names and `HARNESS_MEMBERS`. */
function reachingMembers(tree: Tree, members: Map<string, string>) {
  const files = tree.files.filter((f) =>
    /^test\/(integration\/e2e|docker)\//.test(f),
  );
  const importers = new Map<string, string[]>();
  for (const source of files.filter(
    (f) => f.endsWith('.ts') && !ROOTS.has(f),
  )) {
    const text = tree.read(source);
    const imported = [...text.matchAll(/(?:from|import) '(\.[^']+)'/g)].map(
      (m) => normalize(join(dirname(source), m[1])).replace(/\.js$/, '.ts'),
    );
    // A `.dockerignore` goes with the Dockerfile it is named for.
    const named = files.filter(
      (f) => f !== source && text.includes(basename(f, '.dockerignore')),
    );
    for (const target of [...imported, ...named])
      importers.set(target, [...(importers.get(target) ?? []), source]);
  }
  const reach = new Map<string, Set<string>>();
  const visit = (file: string, seen: Set<string>): Set<string> => {
    if (reach.has(file)) return reach.get(file)!;
    const found = new Set<string>();
    if (seen.has(file)) return found;
    seen.add(file);
    if (isSpec(file)) found.add(memberOf(file));
    for (const { pattern, members: wanted } of HARNESS_MEMBERS)
      if (pattern.test(file))
        for (const [m, family] of members)
          if (wanted.test(`${family}/${m}`)) found.add(m);
    for (const importer of importers.get(file) ?? [])
      for (const m of visit(importer, seen)) found.add(m);
    reach.set(file, found);
    return found;
  };
  for (const file of files) visit(file, new Set());
  return reach;
}

/** Workflows naming `member`, directly or as `${{ matrix.provider }}-<rest>`. */
function workflowsFor(member: string, workflows: Record<string, string>) {
  const rest = member.replace(/^(aws|gcp|azure|lambda)-/, '');
  const names = [member];
  if (rest !== member) names.push(`\\$\\{\\{ matrix\\.provider \\}\\}-${rest}`);
  const pattern = new RegExp(`(^|[^\\w-])(${names.join('|')})([^\\w-]|$)`);
  return Object.keys(workflows).filter((w) => pattern.test(workflows[w]));
}

export interface Input {
  changes: FileChange[];
  head: Tree;
  base: Tree;
  workflows: Record<string, string>;
}

export function renderE2e({ changes, head, base, workflows }: Input): string {
  const specs = [...new Set([...head.files, ...base.files].filter(isSpec))];
  const family = new Map(
    specs.map((f) => [
      memberOf(f),
      /contracts\/([^/]+)\//.exec(f)?.[1] ?? 'standalone',
    ]),
  );
  const tier = (m: string) => {
    const found = workflowsFor(m, workflows);
    return found.includes('integration.yml') ? 'free' : found.join(', ') || '?';
  };
  const direct = new Map<string, FileChange[]>();
  for (const c of changes) {
    const member = isSpec(c.path)
      ? memberOf(c.path)
      : c.path.startsWith(MAPS)
        ? basename(c.path, '.json')
        : undefined;
    if (member) direct.set(member, [...(direct.get(member) ?? []), c]);
  }
  const required = new Set<string>();
  const optional = new Set<string>();
  const unmapped: string[] = [];
  const headReach = reachingMembers(head, family);
  const baseReach = reachingMembers(base, family);
  for (const c of changes) {
    if (c.path.endsWith('.md')) continue;
    if (E2E_FILE.test(c.path)) {
      const workflow = /^\.github\/workflows\/(.+)$/.exec(c.path)?.[1];
      let members = workflow
        ? [...family.keys()].filter((m) =>
            workflowsFor(m, workflows).includes(workflow),
          )
        : [...(headReach.get(c.path) ?? baseReach.get(c.path) ?? [])];
      if (c.path.startsWith(MAPS)) members.push(basename(c.path, '.json'));
      // A deleted file nothing reaches any more runs in no member; whatever
      // imported it changed too and is classified itself.
      else if (!members.length && c.status !== 'D') unmapped.push(label(c));
      const paidOnly = PAID_HARNESS.find(({ pattern }) => pattern.test(c.path));
      if (paidOnly) {
        const match = paidOnly.pattern.exec(c.path)!;
        const wanted = new RegExp(paidOnly.members.replace('$1', match[1]));
        const fits = (m: string) => wanted.test(`${family.get(m)}/${m}`);
        const narrowed = members.filter(fits);
        members = (
          narrowed.length ? narrowed : [...family.keys()].filter(fits)
        ).filter((m) => tier(m) !== 'free');
      }
      // A shared harness file that free members run leaves its paid members
      // optional; `*-invalid` members are rejected before launch, so they run none.
      const shared =
        !workflow &&
        !isSpec(c.path) &&
        !paidOnly &&
        members.some((m) => tier(m) === 'free' && !m.endsWith('-invalid'));
      for (const m of members)
        (shared && tier(m) !== 'free' ? optional : required).add(m);
    } else if (isRuntime(c.path)) {
      const entry = layerOf(c.path);
      if (!entry) unmapped.push(label(c));
      for (const s of entry?.substrates ?? [])
        for (const m of family.keys())
          if (SUBSTRATE_MEMBERS[s].test(m))
            (tier(m) === 'free' ? required : optional).add(m);
      for (const { pattern, members } of PAID_CODE) {
        const match = pattern.exec(c.path);
        const wanted = match && new RegExp(members.replace('$1', match[1]));
        for (const m of family.keys()) if (wanted?.test(m)) required.add(m);
      }
    }
  }
  const live = (set: Set<string>) =>
    [...set]
      .filter((m) => head.files.some((f) => isSpec(f) && memberOf(f) === m))
      .sort();
  const list = (members: string[]) => members.map((m) => `\`${m}\``).join(', ');
  const byGroup = (members: string[]) => {
    const groups = new Map<string, string[]>();
    for (const m of members) {
      const key = `\`${family.get(m)}\` via ${tier(m)}`;
      groups.set(key, [...(groups.get(key) ?? []), m]);
    }
    return [...groups];
  };
  const free = live(required).filter((m) => tier(m) === 'free');
  const paid = live(required).filter((m) => tier(m) !== 'free');
  const extra = live(optional).filter((m) => !required.has(m));
  return [
    '### E2E',
    '',
    ...(direct.size
      ? [
          '| Member | Files | CI tier |',
          '| --- | --- | --- |',
          ...[...direct].map(
            ([m, files]) => `| \`${m}\` | ${cell(files)} | ${tier(m)} |`,
          ),
        ]
      : ['No end-to-end member changed.']),
    '',
    `- Required, free in \`integration.yml\`: ${free.length ? list(free) : 'none'}.`,
    `- Required, paid (a linked green dispatch each):${paid.length ? '' : ' none.'}`,
    ...byGroup(paid).map(([key, members]) => `  - ${key}: ${list(members)}`),
    ...(extra.length
      ? [
          `- Optional, as the free members above cover the same code: ${byGroup(
            extra,
          )
            .map(([key, members]) => `${key} (${members.length})`)
            .join(', ')}.`,
        ]
      : []),
    ...(unmapped.length
      ? ['', `Unmapped, so classify them: ${unmapped.join(', ')}.`]
      : []),
  ].join('\n');
}

/** Parses `git diff -z --name-status` and `git diff -z --numstat`, both with rename detection. */
export function parseDiff(nameStatus: string, numstat: string): FileChange[] {
  const lines = new Map<string, [number, number]>();
  const stats = numstat.split('\0');
  for (let i = 0; i < stats.length - 1; i++) {
    const [added, deleted, path] = stats[i].split('\t');
    // A rename leaves the path empty and puts the old and new paths in the next two fields.
    const key = path || stats[(i += 2)];
    lines.set(key, [Number(added) || 0, Number(deleted) || 0]);
  }
  const changes: FileChange[] = [];
  const fields = nameStatus.split('\0');
  for (let i = 0; i < fields.length - 1; i += 2) {
    const status = fields[i][0];
    const from = status === 'R' ? fields[++i] : undefined;
    const path = fields[i + 1];
    const [added, deleted] = lines.get(path) ?? [0, 0];
    changes.push({ status, path, from, added, deleted });
  }
  return changes;
}

async function main() {
  const { values } = parseArgs({
    options: {
      base: { type: 'string', default: 'origin/main' },
      head: { type: 'string' },
    },
  });
  const root = resolve(fileURLToPath(import.meta.url), '../..');
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, maxBuffer: 1 << 28 }).toString();
  const lines = (text: string) => text.split('\n').filter(Boolean);
  const tree = (ref?: string): Tree => ({
    files: ref
      ? lines(git('ls-tree', '-r', '--name-only', ref))
      : // The index still lists a file deleted but not yet staged.
        lines(
          git('ls-files', '--cached', '--others', '--exclude-standard'),
        ).filter((path) =>
          statSync(join(root, path), { throwIfNoEntry: false }),
        ),
    read: (path) =>
      ref
        ? git('show', `${ref}:${path}`)
        : readFileSync(join(root, path), 'utf8'),
  });
  // Like a PR diff, compare against the merge base; without --head, include the working tree.
  const mergeBase = git(
    'merge-base',
    values.base,
    values.head ?? 'HEAD',
  ).trim();
  const diff = (format: string) =>
    git(
      'diff',
      '-z',
      format,
      '--find-renames',
      mergeBase,
      ...(values.head ? [values.head] : []),
    );
  const changes = parseDiff(diff('--name-status'), diff('--numstat'));
  // `git diff` skips untracked files, so count new ones in the working tree as added.
  if (!values.head)
    for (const path of lines(
      git('ls-files', '--others', '--exclude-standard'),
    )) {
      // Skip directories behind symlinks (such as a linked node_modules).
      if (!statSync(join(root, path), { throwIfNoEntry: false })?.isFile())
        continue;
      const added =
        readFileSync(join(root, path), 'utf8').split('\n').length - 1;
      changes.push({ status: 'A', path, added, deleted: 0 });
    }
  const head = tree(values.head);
  const base = tree(mergeBase);
  const workflowsOf = (at: Tree) =>
    Object.fromEntries(
      at.files
        .filter((f) => E2E_FILE.test(f) && f.startsWith('.github/'))
        .map((f) => [basename(f), at.read(f)]),
    );
  // A deleted workflow still names the members it ran.
  const workflows = { ...workflowsOf(base), ...workflowsOf(head) };
  console.log(renderLayers(changes));
  console.log();
  console.log(renderE2e({ changes, head, base, workflows }));
  console.log();
  // The base is the committed document; the working tree's is regenerated.
  console.log(
    base.files.includes(OPENAPI_PATH)
      ? renderOpenApiDiff(
          JSON.parse(base.read(OPENAPI_PATH)),
          JSON.parse(
            values.head ? head.read(OPENAPI_PATH) : await renderOpenApi(),
          ),
        )
      : `### API contract\n\nThe merge base has no \`${OPENAPI_PATH}\`.`,
  );
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url))
  await main();
