import { PassThrough } from 'stream';

const TICK_MS = 250;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Wrap a Readable so each chunk that flows through updates a one-line
 * stderr progress display. Only writes when stderr is a TTY so logs and
 * pipes stay clean.
 *
 * Returns a PassThrough you pipe in place of the original stream. Pass
 * the total byte count when known to render a percentage; otherwise the
 * display shows a running byte count.
 */
export function withByteProgress(
  source: NodeJS.ReadableStream,
  label: string,
  total?: number,
): NodeJS.ReadableStream {
  if (!process.stderr.isTTY) return source;

  const through = new PassThrough();
  let sent = 0;
  let lastRender = 0;
  let lastWritten = '';

  const render = (final = false) => {
    const now = Date.now();
    if (!final && now - lastRender < TICK_MS) return;
    lastRender = now;
    const sentStr = formatBytes(sent);
    const pct =
      total && total > 0
        ? ` (${Math.min(100, Math.floor((sent / total) * 100))}%)`
        : '';
    const line = `   ${label} ${sentStr}${total ? ` / ${formatBytes(total)}` : ''}${pct}`;
    process.stderr.write(
      `\r${line}${' '.repeat(Math.max(0, lastWritten.length - line.length))}`,
    );
    lastWritten = line;
  };

  source.on('data', (chunk: Buffer | string) => {
    sent += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
    render();
  });
  source.on('end', () => {
    render(true);
    process.stderr.write('\n');
  });
  source.on('error', (err) => {
    process.stderr.write('\n');
    through.destroy(err);
  });

  source.pipe(through);
  return through;
}
