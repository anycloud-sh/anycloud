import type { CloudResourceScope } from './entities.js';

const SCOPE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const TAG_KEY_PATTERN = /^[A-Za-z0-9_.:/-]+$/;

export function createCloudResourceScope(
  id: string,
  tags: Readonly<Record<string, string>> = {},
): CloudResourceScope {
  const normalizedId = id.trim();
  if (!SCOPE_ID_PATTERN.test(normalizedId)) {
    throw new Error(
      'Cloud resource scope id must be 1..63 lowercase letters, digits, or hyphens',
    );
  }

  const normalizedTags: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags)) {
    const normalizedKey = key.trim();
    const normalizedValue = value.trim();
    if (!TAG_KEY_PATTERN.test(normalizedKey) || !normalizedValue) {
      throw new Error(`Invalid cloud resource scope tag: ${key}`);
    }
    normalizedTags[normalizedKey] = normalizedValue;
  }

  return Object.freeze({
    id: normalizedId,
    tags: Object.freeze(normalizedTags),
  });
}
