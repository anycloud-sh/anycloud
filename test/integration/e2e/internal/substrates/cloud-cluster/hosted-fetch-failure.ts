import { readFile } from 'node:fs/promises';

import type { ProcessRunner } from '../../process.js';
import type { CommandResult } from '../../types.js';

/**
 * The CLI's bare connection or DNS error: no HTTP status came back.
 * A Bun-compiled CLI, such as a published release's, says `Unable to connect`.
 */
const FETCH_FAILED = /\bfetch failed\b|\bUnable to connect\b/u;

/**
 * The runner's resolver, Cloudflare's DNS-over-HTTPS answer, and the request
 * through the edge: which of DNS and the edge lost `url`. The origin accepts
 * only Cloudflare, so the edge's 52x answer is the origin evidence. `dig` asks
 * the first `resolv.conf` nameserver (the VPC resolver) and 1.1.1.1 directly:
 * its rcode, EDE and SOA TTL tell an error answer from a cached NXDOMAIN or
 * NODATA.
 */
export function fetchFailureProbes(
  url: string,
  resolvConf: string,
): readonly (readonly [label: string, args: readonly string[]])[] {
  const host = new URL(url).hostname;
  const curl = ['curl', '-sv', '--max-time', '20'];
  // Without a nameserver, dig asks its own default: still the runner's view.
  const vpc = /^nameserver\s+(\S+)/mu.exec(resolvConf)?.[1];
  const sections = ['+noall', '+comments', '+answer', '+authority', '+stats'];
  const dig = (server: readonly string[], type: string) => [
    'dig',
    ...server,
    host,
    type,
    ...sections,
    '+tries=1',
    '+time=5',
  ];
  return [
    ['getent', ['getent', 'hosts', host]],
    [
      'doh',
      [
        ...curl,
        '-H',
        'accept: application/dns-json',
        `https://1.1.1.1/dns-query?name=${host}&type=A`,
      ],
    ],
    ['edge', [...curl, url]],
    ...['A', 'AAAA'].flatMap((type) => [
      [`dig-vpc-${type}`, dig(vpc ? [`@${vpc}`] : [], type)] as const,
      [`dig-public-${type}`, dig(['@1.1.1.1'], type)] as const,
    ]),
  ];
}

/**
 * Records the probes, as command artifacts, at an outage's first `fetch
 * failed`; a successful call ends the outage. It never throws, so the call's
 * own result is the step's outcome.
 */
export class FetchFailureCapture {
  readonly #runner: Pick<ProcessRunner, 'run'>;
  readonly #url: () => string;
  #onsets = 0;
  #inOutage = false;
  #pending: Promise<unknown> = Promise.resolve();

  constructor(runner: Pick<ProcessRunner, 'run'>, url: () => string) {
    this.#runner = runner;
    this.#url = url;
  }

  /** Starts the probes in the background, so the call's timing is unchanged. */
  observe(result: CommandResult): void {
    if (result.exitCode === 0) {
      this.#inOutage = false;
      return;
    }
    if (this.#inOutage || !FETCH_FAILED.test(result.combined)) return;
    this.#inOutage = true;
    this.#onsets += 1;
    this.#pending = Promise.all([
      this.#pending,
      this.#probe(`hosted-fetch-failed-${this.#onsets}`),
    ]);
  }

  /** The probes for another URL that got no HTTP answer, such as a published Service's. */
  probeUrl(url: string, prefix: string): void {
    this.#pending = Promise.all([
      this.#pending,
      this.#probe(prefix, () => url),
    ]);
  }

  /** Every probe started so far, recorded; it never rejects. */
  async settled(): Promise<void> {
    await this.#pending;
  }

  async #probe(
    prefix: string,
    url = () => new URL('/v1/version', this.#url()).href,
  ): Promise<void> {
    try {
      const probes = fetchFailureProbes(
        url(),
        await readFile('/etc/resolv.conf', 'utf8').catch(() => ''),
      );
      await Promise.allSettled(
        probes.map(([label, [executable, ...args]]) =>
          this.#runner.run(executable, args, { label: `${prefix}-${label}` }),
        ),
      );
    } catch {
      // Evidence only: the cluster record may be gone.
    }
  }
}
