#!/usr/bin/env tsx
/**
 * Anti-drift gate for the anycloud skill.
 *
 * `claude plugin validate` only checks the plugin manifest, NOT SKILL.md — so it
 * cannot catch the skill documenting a command that no longer exists. This script
 * closes that gap: it extracts every `anycloud <verb>` referenced in SKILL.md and
 * asserts each verb is a real top-level command (or known alias) registered in
 * src/cli/index.ts. It also rejects known stale setup claims in SKILL.md, the
 * skill's README and INSTALL, and the docs pages Setup rests on
 * (getting-started, api-utilities, container-images, secrets-environment), and
 * requires SKILL.md to keep the current ones. SKILL.md and Getting Started
 * must link each provider's published role. Exits non-zero on any drift.
 *
 * Run by .github/workflows/skills.yml.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const INDEX = join(repoRoot, 'src/cli/index.ts');
const SKILL = join(repoRoot, 'anycloud-skills/skills/anycloud/SKILL.md');
const GETTING_STARTED = join(repoRoot, 'docs/introduction/getting-started.md');
// Docusaurus only warns on a broken anchor, so the role headings are checked.
const CREDENTIALS = join(repoRoot, 'docs/reference/cli/credentials.md');
// The skill plus the docs pages its Setup steps rest on.
const SKILL_FILES = [
  SKILL,
  'anycloud-skills/README.md',
  'anycloud-skills/INSTALL.md',
  GETTING_STARTED,
  'docs/reference/cli/api-utilities.md',
  'docs/platform/container-images.md',
  'docs/platform/secrets-environment.md',
].map((file) => (file.startsWith('/') ? file : join(repoRoot, file)));

// Claims that were once true and must not come back.
const STALE: Array<[RegExp, string]> = [
  [
    /`(workflow|project)` permission/,
    'login asks GitHub only for read:org read:packages',
  ],
  [
    /(authenticates|logs)[^.\n]*Docker( CLI)? (in)?to GHCR|Push rejected[^\n]*anycloud login/i,
    'login does not set up Docker; pushes use gh',
  ],
  [
    /receives? the token as `?GITHUB_TOKEN|submitter's `?GITHUB_TOKEN/i,
    'workloads get no sign-in token; Git access comes from --secret',
  ],
  [/--generate[^.\n]*unsupported/i, '--generate works for AWS, Azure and GCP'],
  [
    /Logged in: `anycloud login`/,
    'a local API runs public images without GitHub sign-in',
  ],
];

// Claims SKILL.md must keep.
const REQUIRED: Array<[RegExp, string]> = [
  [/read:org read:packages/, 'the login scopes'],
  [/gh auth token \|\s*(\\\s*)?docker login ghcr\.io/, 'the gh push path'],
  [/anycloud api use\b/, 'selecting an existing hosted API'],
  [/runs public images without\s+GitHub/, 'the no-sign-in local start'],
  [/actionRequired/, 'relaying agent sign-in'],
  [/Never\s+ask for[^.]*(token|secret)/, 'the secret rule'],
  [/I don.t have/, 'the administrator handoff'],
  [/(never|don.t) install cloud CLIs/i, 'missing cloud CLIs'],
];

// Real top-level commands: createXCommand -> kebab-case verb.
const index = readFileSync(INDEX, 'utf8');
const commands = new Set<string>();
for (const m of index.matchAll(/create([A-Za-z]+)Command/g)) {
  commands.add(m[1].replace(/(?<!^)(?=[A-Z])/g, '-').toLowerCase());
}
// Registered names that differ from their create*Command factory (`job` from
// createSubmitCommand, `service` from createServeCommand), plus aliases and
// global flags that aren't their own create*Command.
for (const extra of ['job', 'service', 'ls', 'creds', '--version'])
  commands.add(extra);

// Verbs the skill tells the agent to run.
const skill = readFileSync(SKILL, 'utf8');
const referenced = new Set<string>();
for (const m of skill.matchAll(/anycloud (--version|[a-z][a-z-]*)/g)) {
  referenced.add(m[1]);
}

const missing = [...referenced].filter((v) => !commands.has(v)).sort();

const claims: string[] = [];
for (const file of SKILL_FILES) {
  const text = readFileSync(file, 'utf8');
  for (const [pattern, fact] of STALE) {
    const hit = text.match(pattern);
    if (hit)
      claims.push(`${file.slice(repoRoot.length + 1)}: "${hit[0]}" (${fact})`);
  }
}
for (const [pattern, step] of REQUIRED) {
  if (!pattern.test(skill)) claims.push(`SKILL.md lacks ${step} (${pattern})`);
}
// Each provider's published role, linked from Setup and Getting Started.
const credentialsDoc = readFileSync(CREDENTIALS, 'utf8');
for (const provider of ['AWS', 'Azure', 'GCP']) {
  if (!new RegExp(`^### ${provider} permissions$`, 'm').test(credentialsDoc))
    claims.push(
      `credentials.md lacks the "### ${provider} permissions" heading`,
    );
}
for (const file of [SKILL, GETTING_STARTED]) {
  const text = readFileSync(file, 'utf8');
  for (const provider of ['aws', 'azure', 'gcp']) {
    if (!text.includes(`credentials#${provider}-permissions`))
      claims.push(
        `${file.slice(repoRoot.length + 1)} lacks the ${provider} published role link`,
      );
  }
}
if (claims.length > 0) {
  console.error('✘ skill drift: stale or missing setup claims:');
  for (const c of claims) console.error(`    ${c}`);
  process.exitCode = 1;
}

if (missing.length > 0) {
  console.error(
    '✘ skill drift: SKILL.md references commands not in the CLI registry:',
  );
  for (const v of missing) console.error(`    anycloud ${v}`);
  console.error('\nFix SKILL.md or update src/cli/index.ts.');
  process.exit(1);
}

if (!process.exitCode)
  console.log(
    `✔ skill anti-drift: all ${referenced.size} referenced commands exist; setup claims current.`,
  );
