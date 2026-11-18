export function parseJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function recordValue(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

export function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

export function parseJsonRecord(
  text: string,
  description = 'JSON value',
): Record<string, unknown> {
  const value = parseJson(text);
  if (!isRecord(value)) {
    throw new TypeError(`${description} must be a JSON object.`);
  }
  return value;
}

export function parseJsonArray(
  text: string,
  description = 'JSON value',
): unknown[] {
  const value = parseJson(text);
  if (!isUnknownArray(value)) {
    throw new TypeError(`${description} must be a JSON array.`);
  }
  return value;
}
