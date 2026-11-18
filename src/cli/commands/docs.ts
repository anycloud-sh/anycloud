import { Command } from 'commander';
import { printError } from '../utils/output.js';
import { errorMessage } from '../../shared/log-diagnostics.js';

const DOCS_BASE = 'https://anycloud.sh';
const INDEX_PATH = '/llms.txt';
const FULL_PATH = '/llms-full.txt';
const FETCH_TIMEOUT_MS = 10_000;

async function fetchText(path: string): Promise<string> {
  const url = `${DOCS_BASE}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`${url} returned HTTP ${res.status}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

export function createDocsCommand(): Command {
  return new Command('docs')
    .description(
      '📚 Print anycloud docs (index by default, --all for full corpus)',
    )
    .option('--all', 'Print the full markdown corpus instead of the index')
    .option('--url', 'Print the docs URL instead of fetching')
    .action(async (opts: { all?: boolean; url?: boolean }) => {
      const path = opts.all ? FULL_PATH : INDEX_PATH;
      if (opts.url) {
        process.stdout.write(`${DOCS_BASE}${path}\n`);
        return;
      }
      try {
        const body = await fetchText(path);
        process.stdout.write(body);
        if (!body.endsWith('\n')) process.stdout.write('\n');
      } catch (err) {
        const msg = errorMessage(err);
        printError(`Failed to fetch docs: ${msg}`);
        process.exit(1);
      }
    });
}
