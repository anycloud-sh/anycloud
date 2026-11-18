export const DIAGNOSTIC_TAIL_CHARS = 4000;
/** Bounds one event's error text; unbounded messages once bloated these rows. */
export const MAX_PERSISTED_ERROR_MESSAGE_CHARS = 2048;
/** Names are identifiers, not prose; a long one is a bug, not information. */
const MAX_PERSISTED_ERROR_NAME_CHARS = 128;
/**
 * A log line may carry more than a database column, but not without limit.
 * Both are generous next to a real failure and finite next to a pathological
 * one — a recursive call's stack and a message built in a retry loop have no
 * natural size.
 */
export const MAX_LOGGED_ERROR_MESSAGE_CHARS = 4096;
export const MAX_LOGGED_ERROR_STACK_CHARS = 8192;
/** Cause chains are usually two or three deep; a longer one is a cycle. */
const MAX_LOGGED_CAUSE_DEPTH = 5;

/**
 * An error that has already been reduced to plain data, so it survives being
 * written. A class instance has no index signature and is therefore not
 * assignable here — which is the point: see RFC 0023.
 */
export interface PersistedError {
  name?: string;
  message?: string;
  [key: string]: unknown;
}

const DIAGNOSTIC_TEXT_FIELD_GROUPS = [
  {
    label: 'Docker output',
    fields: ['pullStderr', 'pullStdout'],
  },
  {
    label: 'Command output',
    fields: ['logTail', 'stderr', 'stdout'],
  },
] as const;

const DIAGNOSTIC_STRING_FIELDS = [
  ...DIAGNOSTIC_TEXT_FIELD_GROUPS.flatMap((group) => group.fields),
  'diskSpace',
] as const;

const DIAGNOSTIC_SCALAR_FIELDS = [
  'exitCode',
  'elapsedMs',
  'code',
  'status',
  'statusCode',
] as const;

export interface DiagnosticSection {
  label: string;
  text: string;
}

interface NormalizeLogOptions {
  tailChars?: number;
  maxLines?: number;
}

const ANSI_ESCAPE_RE =
  // eslint-disable-next-line no-control-regex
  /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

export function normalizeLogText(
  value: string | undefined | null,
  options: NormalizeLogOptions = {},
): string | null {
  if (!value) return null;
  const tailChars = options.tailChars ?? DIAGNOSTIC_TAIL_CHARS;
  let text = value
    .replace(ANSI_ESCAPE_RE, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!text) return null;
  if (Number.isFinite(tailChars) && tailChars > 0) {
    text = text.slice(-tailChars).trim();
  }
  if (options.maxLines !== undefined && options.maxLines > 0) {
    text = text.split('\n').slice(-options.maxLines).join('\n').trim();
  }
  return text || null;
}

export function diagnosticDedupeKey(text: string): string {
  return normalizeLogText(text, { tailChars: Number.POSITIVE_INFINITY }) ?? '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringField(value: unknown, field: string): string | null {
  if (!isRecord(value)) return null;
  const fieldValue = value[field];
  return typeof fieldValue === 'string' ? fieldValue : null;
}

function collectDiagnosticText(value: unknown, fields: readonly string[]) {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const field of fields) {
    const clean = normalizeLogText(stringField(value, field));
    if (!clean) continue;
    const key = diagnosticDedupeKey(clean);
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(clean);
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

export function collectDiagnosticSections(value: unknown): DiagnosticSection[] {
  const seen = new Set<string>();
  const sections: DiagnosticSection[] = [];
  for (const { label, fields } of DIAGNOSTIC_TEXT_FIELD_GROUPS) {
    const text = collectDiagnosticText(value, fields);
    if (!text) continue;
    const key = diagnosticDedupeKey(text);
    if (seen.has(key)) continue;
    seen.add(key);
    sections.push({ label, text });
  }
  return sections;
}

/**
 * The readable text of an unknown thrown value.
 *
 * `String(value)` yields "[object Object]" for a plain object, which is the
 * same loss of reason as persisting a raw Error, at a different boundary.
 * Prefer this over hand-rolling `instanceof Error ? e.message : String(e)`.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error !== null && typeof error === 'object') {
    try {
      return JSON.stringify(error) ?? String(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

export function errorForDiagnosticMetadata(
  error: unknown,
): PersistedError | string {
  // A thrown value that is not an Error still has fields worth keeping;
  // String() would flatten them to "[object Object]".
  if (!(error instanceof Error)) {
    return errorMessage(error).slice(0, MAX_PERSISTED_ERROR_MESSAGE_CHARS);
  }

  const source: Record<string, unknown> = isRecord(error) ? error : {};
  const metadata: PersistedError = {
    // Capped here rather than at each call site, so no boundary forgets it.
    message: error.message.slice(0, MAX_PERSISTED_ERROR_MESSAGE_CHARS),
    name: error.name.slice(0, MAX_PERSISTED_ERROR_NAME_CHARS),
  };

  for (const key of DIAGNOSTIC_STRING_FIELDS) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) {
      metadata[key] = value;
    }
  }

  for (const key of DIAGNOSTIC_SCALAR_FIELDS) {
    const value = source[key];
    if (
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      (typeof value === 'string' && value.trim())
    ) {
      metadata[key] = value;
    }
  }

  return metadata;
}

/** Marks a cut so a reader does not hunt for a frame that was never written. */
function bound(value: string, limit: number): string {
  return value.length <= limit
    ? value
    : `${value.slice(0, limit)}… [truncated ${value.length - limit} chars]`;
}

/**
 * Bound the strings in an already-serialized error on its way to a log line.
 *
 * The persisted boundary caps its message because unbounded text once bloated
 * the events table (RFC 0023). Logs have the same exposure through `stack`,
 * which serializeError keeps and nothing downstream measures, so the cap
 * belongs here rather than at each of the call sites that log an error.
 */
export function boundLoggedError(serialized: unknown, depth = 0): unknown {
  if (serialized === null || typeof serialized !== 'object') return serialized;
  if (depth > MAX_LOGGED_CAUSE_DEPTH) return '[MAX_CAUSE_DEPTH_EXCEEDED]';

  const source: Record<string, unknown> = { ...serialized };
  if (typeof source.message === 'string') {
    source.message = bound(source.message, MAX_LOGGED_ERROR_MESSAGE_CHARS);
  }
  if (typeof source.stack === 'string') {
    source.stack = bound(source.stack, MAX_LOGGED_ERROR_STACK_CHARS);
  }
  if (source.cause !== undefined) {
    source.cause = boundLoggedError(source.cause, depth + 1);
  }
  return source;
}
