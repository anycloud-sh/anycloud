#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import semver from 'semver';
import { ENTRY_DIR, listEntryFiles } from './ci/fold-changelog-entries.mjs';

function fail(message) {
  console.error(`release state check failed: ${message}`);
  process.exit(1);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    fail(`could not read ${path}: ${err.message}`);
  }
}

const requireTag = process.argv.includes('--require-tag');
const packageJson = readJson('package.json');
const version = process.env.VERSION || packageJson.version;

if (packageJson.version !== version) {
  fail(
    `package.json version ${packageJson.version} does not match VERSION=${version}`,
  );
}

if (packageJson.private !== true) {
  fail('package.json must remain private; the npm package is decommissioned');
}

for (const field of ['bin', 'files']) {
  if (Object.hasOwn(packageJson, field)) {
    fail(
      `package.json must not declare ${field}; the npm package is decommissioned`,
    );
  }
}

if (
  packageJson.scripts?.prepublishOnly !== 'node scripts/block-npm-publish.js'
) {
  fail(
    'package.json must keep prepublishOnly blocked; the npm package is decommissioned',
  );
}

// The client window admits the release this one replaces (api-version.ts).
if (
  !semver.valid(packageJson.previousVersion) ||
  !semver.lt(packageJson.previousVersion, version)
) {
  fail(
    `package.json previousVersion ${packageJson.previousVersion} must be the release before ${version}`,
  );
}

const pyproject = readFileSync('python/pyproject.toml', 'utf8');
const pyprojectVersion = pyproject.match(/^version = "([^"]+)"/m)?.[1];
if (!pyprojectVersion) {
  fail('could not find version in python/pyproject.toml');
}
if (pyprojectVersion !== version) {
  fail(
    `python/pyproject.toml version ${pyprojectVersion} does not match package.json version ${version}`,
  );
}

const generatedInit = readFileSync(
  'python/generated/anycloud/__init__.py',
  'utf8',
);
const generatedVersion = generatedInit.match(/^__version__ = "([^"]+)"/m)?.[1];
if (!generatedVersion) {
  fail('could not find __version__ in python/generated/anycloud/__init__.py');
}
if (generatedVersion !== version) {
  fail(
    `generated Python SDK version ${generatedVersion} does not match package.json version ${version}`,
  );
}

const skillPlugin = readJson('anycloud-skills/.claude-plugin/plugin.json');
if (skillPlugin.version !== version) {
  fail(
    `anycloud-skills/.claude-plugin/plugin.json version ${skillPlugin.version} does not match package.json version ${version}`,
  );
}

const skillMarketplace = readJson(
  'anycloud-skills/.claude-plugin/marketplace.json',
);
const marketplaceMetadataVersion = skillMarketplace.metadata?.version;
if (marketplaceMetadataVersion !== version) {
  fail(
    `anycloud-skills/.claude-plugin/marketplace.json metadata.version ${marketplaceMetadataVersion} does not match package.json version ${version}`,
  );
}

const marketplacePlugin = skillMarketplace.plugins?.find(
  (plugin) => plugin.name === 'anycloud',
);
if (!marketplacePlugin) {
  fail(
    'anycloud-skills/.claude-plugin/marketplace.json is missing a plugin named "anycloud"',
  );
}
if (marketplacePlugin.version !== version) {
  fail(
    `anycloud-skills/.claude-plugin/marketplace.json anycloud plugin version ${marketplacePlugin.version} does not match package.json version ${version}`,
  );
}

// Checked before the heading below, so the operator gets the actionable
// failure. The fold takes no version — it derives the patch this workflow will
// cut — so the same command is correct here and on the release branch, and
// re-running it absorbs an entry that landed after the release PR folded.
const pendingEntries = listEntryFiles();
if (pendingEntries.length > 0) {
  fail(
    `${ENTRY_DIR} still holds ${pendingEntries.length} unreleased entry file(s) ` +
      `(${pendingEntries.join(', ')}); run \`yarn changelog:fold\` ` +
      'and merge that before releasing',
  );
}

const changelog = readFileSync('docs/changelog.md', 'utf8');
const versionHeading = new RegExp(`^## ${escapeRegExp(version)}$`, 'm');
if (!versionHeading.test(changelog)) {
  fail(`docs/changelog.md is missing a "## ${version}" section`);
}

if (requireTag) {
  const tag = `v${version}`;
  const tagSha = execFileSync('git', ['rev-parse', `${tag}^{}`], {
    encoding: 'utf8',
  }).trim();
  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();

  if (tagSha !== headSha) {
    fail(`${tag} points at ${tagSha}, but HEAD is ${headSha}`);
  }
}

console.log(`release state check passed for ${version}`);
