/** Collapse a quota label/name to a stable, separator-free key fragment. */
export function normalizeResourceKeyPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}
