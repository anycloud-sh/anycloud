import * as semver from 'semver';

export const CHANGELOG_URL = 'https://anycloud.sh/changelog';
const RELATIVE_LINK = /\[([^\]]+)]\(((?:\/|\.{1,2}\/|#)[^)\s]+)([^)]*)\)/g;

export function extractReleaseNotes(
  changelog: string,
  version: string,
): string {
  if (!semver.valid(version)) {
    throw new Error(`invalid release version: ${version}`);
  }

  const heading = `## ${version}`;
  const section = changelog
    .replace(/\r\n/g, '\n')
    .split(/^## /m)
    .find((value) => value === version || value.startsWith(`${version}\n`));
  if (section === undefined) {
    throw new Error(`docs/changelog.md is missing a "${heading}" section`);
  }
  const notes = section.slice(version.length).trim();
  if (!notes) {
    throw new Error(`docs/changelog.md has an empty "${heading}" section`);
  }
  return normalizeReleaseNotesLinks(notes);
}

/** Resolve documentation links so GitHub and Slack do not treat them as local. */
function normalizeReleaseNotesLinks(notes: string): string {
  return notes.replace(
    RELATIVE_LINK,
    (_original, label: string, href: string, suffix: string) =>
      `[${label}](${new URL(href, CHANGELOG_URL).toString()}${suffix})`,
  );
}

export function formatReleaseUpdateNotification(
  version: string,
  releaseUrl: string,
): string {
  return [
    `:arrow_up: *Anycloud v${version} is available*`,
    '*Update with:* `anycloud update`',
    `<${releaseUrl}|What's new in v${version}>`,
  ].join('\n');
}
