/**
 * Response headers as `fetch` and the Azure SDK expose them, or as a record
 * with lowercase names, as Node, the AWS SDK and GCS expose them.
 */
export type RetryAfterHeaders =
  | { get(name: string): string | null | undefined }
  | Readonly<Record<string, unknown>>;

/**
 * How long a throttled server asks the caller to wait, in milliseconds, at
 * most `maxMs`. Azure's `retry-after-ms` and `x-ms-retry-after-ms` take
 * precedence over `names`, each of which may hold delay-seconds or an
 * HTTP-date; the longest of them wins. `names` defaults to `Retry-After`.
 * Undefined when no header holds a usable value.
 */
export function retryAfterMs(
  headers: RetryAfterHeaders | undefined,
  now: number,
  {
    maxMs = Infinity,
    names = ['retry-after'],
  }: { maxMs?: number; names?: readonly string[] } = {},
): number | undefined {
  const header = (name: string) => {
    const value =
      typeof headers?.get === 'function'
        ? (headers.get as (name: string) => unknown)(name)
        : (headers as Record<string, unknown> | undefined)?.[name];
    return typeof value === 'string' ? value.trim() : undefined;
  };
  const delay = (value: string | undefined) => {
    const number =
      value !== undefined && /^\d+(?:\.\d+)?$/.test(value)
        ? Number(value)
        : NaN;
    return Number.isFinite(number) ? number : undefined;
  };
  const capped = (ms: number) =>
    Number.isFinite(ms) ? Math.min(maxMs, Math.ceil(ms)) : undefined;
  const wait = (value: string | undefined) => {
    if (value === undefined) return undefined;
    const seconds = delay(value);
    if (seconds !== undefined) return capped(seconds * 1000);
    // An HTTP-date names its weekday and month; Date.parse would also read a
    // bare number such as "-5" as a date.
    const date = /[a-z]/i.test(value) ? Date.parse(value) : NaN;
    return Number.isNaN(date) ? undefined : capped(Math.max(0, date - now));
  };

  const milliseconds =
    delay(header('retry-after-ms')) ?? delay(header('x-ms-retry-after-ms'));
  if (milliseconds !== undefined) return capped(milliseconds);
  const waits = names.flatMap((name) => wait(header(name)) ?? []);
  return waits.length > 0 ? Math.max(...waits) : undefined;
}
