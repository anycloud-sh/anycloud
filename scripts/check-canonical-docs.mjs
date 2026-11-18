#!/usr/bin/env node

// Canonical-document consistency. The documents AGENTS.md names as sources of
// truth cite repository paths, link to each other by heading, and tell
// contributors which `yarn` commands to run. Code moves and script renames
// silently strand those references, so each one must still resolve.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitVisibleFiles } from './repository-policy/git-files.mjs';

export const CANONICAL_DOCS = [
  'AGENTS.md',
  'ARCHITECTURE.md',
  'CONTRIBUTING.md',
  'RELEASE.md',
];

// Path-shaped names that are not repository paths.
const EXTERNAL_PREFIXES = [
  '.context/', // gitignored local handoff notes
  'anycloud-sh/', // GitHub repositories
  'apps/', // Kubernetes API group
  'ghcr.io/', // container images
  'local/', // ESLint plugin rules
  'nvidia.com/', // Kubernetes extended resources
];

// Yarn 1's own commands, which are not package.json scripts.
const YARN_COMMANDS = new Set([
  ...['add', 'audit', 'bin', 'cache', 'config', 'exec', 'info', 'install'],
  ...['list', 'node', 'remove', 'run', 'upgrade', 'version', 'why'],
  ...['workspace', 'workspaces'],
]);

const LINE_SUFFIX = /:\d+(?:[-:]\d+)?$/;

/** GitHub's heading anchors for a Markdown document, outside code fences. */
export function headingAnchors(markdown) {
  const anchors = new Set();
  let fenced = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*(?:```|~~~)/.test(line)) fenced = !fenced;
    const heading = !fenced && /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!heading) continue;
    const base = heading[1]
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-');
    let anchor = base;
    for (let n = 1; anchors.has(anchor); n += 1) anchor = `${base}-${n}`;
    anchors.add(anchor);
  }
  return anchors;
}

/** Inline code spans and fenced code blocks, with their offsets. */
function codeSegments(source) {
  const fences = [
    ...source.matchAll(/^ *(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ *\1/gm),
  ].map(({ 0: text, index }) => ({ text, index }));
  const inFence = (index) =>
    fences.some(
      (fence) =>
        index >= fence.index && index < fence.index + fence.text.length,
    );
  const spans = [...source.matchAll(/`([^`\n]+)`/g)]
    .filter(({ index }) => !inFence(index))
    .map(({ 1: text, index }) => ({ text, index: index + 1 }));
  return [...fences, ...spans].sort((a, b) => a.index - b.index);
}

/**
 * @param {Array<{ path: string, source: string }>} docs repo-relative
 * @param {{ exists: (path: string) => boolean, read: (path: string) => string, commands: Set<string> }} repo
 *   `exists` sees only files Git would commit, so ignored local state neither
 *   satisfies nor fails a reference; `commands` are scripts and binaries.
 * @returns {string[]} `doc:line: problem — remedy`
 */
export function findCanonicalDocViolations(docs, { exists, read, commands }) {
  const violations = [];
  for (const { path, source } of docs) {
    const report = (index, problem, remedy) =>
      violations.push(
        `${path}:${source.slice(0, index).split('\n').length}: ${problem} — ${remedy}`,
      );

    // A path is cited from the repository root or from src/.
    for (const { 0: token, 1: cited, index } of source.matchAll(
      /`((?!\.\.?\/)[\w.-]+\/[\w.@/-]*(?::\d+(?:[-:]\d+)?)?)`/g,
    )) {
      if (cited.includes('...')) continue;
      if (EXTERNAL_PREFIXES.some((prefix) => cited.startsWith(prefix)))
        continue;
      const target = cited.replace(LINE_SUFFIX, '');
      const bases = ['', 'src/'];
      if (!bases.some((base) => exists(normalize(base + target)))) {
        report(
          index,
          `${token} does not exist`,
          "cite the file's current path, or remove the reference.",
        );
      }
    }

    for (const { 1: raw, index } of source.matchAll(
      /\]\((<[^>\n]+>|[^)\s]+)\)/g,
    )) {
      const link = raw.replace(/^<(.*)>$/, '$1');
      if (/^[a-z][a-z+.-]*:/i.test(link)) continue;
      const [location, anchor] = link.split('#');
      const file = location.replace(/\?.*$/, '').replace(LINE_SUFFIX, '');
      const target = file ? normalize(join(dirname(path), file)) : path;
      if (file && !exists(target)) {
        report(
          index,
          `link ${link} does not resolve`,
          'point it at the moved file, or remove the link.',
        );
      } else if (
        anchor &&
        target.endsWith('.md') &&
        !headingAnchors(file ? read(target) : source).has(anchor)
      ) {
        report(
          index,
          `link ${link} names no heading in ${target}`,
          "link to the heading's current anchor.",
        );
      }
    }

    for (const segment of codeSegments(source)) {
      for (const { 0: command, 1: name, index } of segment.text.matchAll(
        /\byarn (?:run )?([a-z][\w:.-]*\w)/g,
      )) {
        if (YARN_COMMANDS.has(name) || commands.has(name)) continue;
        report(
          segment.index + index,
          `\`${command}\` names no package.json script, package binary, or Yarn command`,
          "use the script's current name.",
        );
      }
    }
  }
  return violations;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const bin = join(root, 'node_modules/.bin');
  if (!existsSync(bin)) {
    console.error(
      'Canonical document check needs installed dependencies to recognize package binaries: node_modules/.bin is missing. Run `yarn install` first.',
    );
    process.exit(1);
  }
  const read = (path) => readFileSync(join(root, path), 'utf8');
  // Every committed file and each of its parent directories.
  const paths = new Set(
    gitVisibleFiles(root).flatMap((file) =>
      file.split('/').map((_, i, parts) => parts.slice(0, i + 1).join('/')),
    ),
  );
  const violations = findCanonicalDocViolations(
    CANONICAL_DOCS.map((path) => ({ path, source: read(path) })),
    {
      exists: (path) => paths.has(path.replace(/\/$/, '')),
      read,
      commands: new Set([
        ...Object.keys(JSON.parse(read('package.json')).scripts),
        ...readdirSync(bin),
      ]),
    },
  );
  if (violations.length > 0) {
    console.error('Canonical document check failed.');
    for (const violation of violations) console.error(violation);
    process.exit(1);
  }
  console.log(
    `Canonical document check passed (${CANONICAL_DOCS.length} documents).`,
  );
}
