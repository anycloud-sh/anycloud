/**
 * Shared command-addressed fake for the `VmTransport` seam (Phase 1).
 *
 * Replaces the per-file `vi.mock('…/gateways/ssh')` exec stubs. Instead of
 * stubbing `exec` by call ORDER (`mockResolvedValueOnce` chains), register
 * responses by COMMAND (substring or regex), so a reorder of unrelated SSH calls
 * in production code no longer breaks the test.
 *
 * `exec`/`ping` are real `vi.fn()`s, so existing `toHaveBeenCalledWith`,
 * `toHaveBeenCalledTimes`, `mock.calls[i][0]`, and `not.toHaveBeenCalled()`
 * assertions keep working verbatim.
 *
 * Usage (mock the transport seam, NOT the ssh module — keeps SSHManager statics
 * like generateKeypair/derivePublicKey real). The fake must exist before the
 * hoisted vi.mock factory runs, so build it in an async vi.hoisted block:
 *
 *   const { fake } = await vi.hoisted(async () => {
 *     const { createFakeTransport } = await import('../helpers/mock-transport');
 *     return { fake: createFakeTransport() };
 *   });
 *   vi.mock('../../../src/api/services/gateways/transport', () => ({
 *     createTransport: vi.fn(() => fake),
 *   }));
 *   // ...
 *   beforeEach(() => fake.reset());
 *   fake.on('docker inspect', { stdout: JSON.stringify({ Status: 'exited', ... }) });
 *   fake.default({ stdout: '', stderr: '', code: 0 });
 */

import { vi, type Mock } from 'vitest';
import type { VmTransport } from '../../../src/api/services/gateways/transport-contract.js';

export type ExecResult = { stdout: string; stderr: string; code: number };

/**
 * A response is a full ExecResult, a partial (missing fields default to
 * `code:0, stdout:'', stderr:''`), a bare string (treated as stdout), an Error
 * (thrown), or a thunk producing any of those.
 */
export type ExecResponse =
  | Partial<ExecResult>
  | string
  | Error
  | (() => Partial<ExecResult> | string | Error);

type Matcher = string | RegExp;
interface Rule {
  match: Matcher;
  sticky?: ExecResponse;
  queue: ExecResponse[];
}

export interface FakeTransport extends VmTransport {
  exec: Mock<VmTransport['exec']>;
  execStream: Mock<VmTransport['execStream']>;
  writeFile: Mock<VmTransport['writeFile']>;
  ping: Mock<VmTransport['ping']>;
  /** Register a sticky response for a command pattern (substring or regex). */
  on(match: Matcher, resp: ExecResponse): FakeTransport;
  /** Queue one-shot responses for a pattern (FIFO, consumed before its sticky). */
  onceOn(match: Matcher, ...resps: ExecResponse[]): FakeTransport;
  /** Catch-all sticky response for commands no rule matched. */
  default(resp: ExecResponse): FakeTransport;
  /** Catch-all FIFO queue; the last queued response repeats once exhausted. */
  defaultOnce(...resps: ExecResponse[]): FakeTransport;
  /** Sticky ping result (default true). */
  setPing(v: boolean): FakeTransport;
  /** Queue one-shot ping results (FIFO, before the sticky). */
  oncePing(...vals: boolean[]): FakeTransport;
  /** Recorded command strings, in call order. */
  readonly commands: string[];
  /** Clear registry + queues + vi.fn call logs (== mockReset semantics). */
  reset(): void;
}

function normalize(r: ExecResponse | undefined): ExecResult | Error {
  if (r === undefined) return { stdout: '', stderr: '', code: 0 };
  if (typeof r === 'function') return normalize(r());
  if (r instanceof Error) return r;
  if (typeof r === 'string') return { stdout: r, stderr: '', code: 0 };
  return { stdout: '', stderr: '', code: 0, ...r };
}

export function createFakeTransport(): FakeTransport {
  const rules: Rule[] = [];
  let dflt: ExecResponse | undefined;
  const dfltQueue: ExecResponse[] = [];
  let pingSticky = true;
  const pingQueue: boolean[] = [];
  const commands: string[] = [];

  const matches = (m: Matcher, cmd: string): boolean =>
    typeof m === 'string' ? cmd.includes(m) : m.test(cmd);

  const pick = (cmd: string): ExecResponse | undefined => {
    const rule = rules.find((r) => matches(r.match, cmd));
    if (rule) return rule.queue.length ? rule.queue.shift() : rule.sticky;
    // Catch-all queue: consume FIFO, but keep the last entry sticky.
    if (dfltQueue.length)
      return dfltQueue.length > 1 ? dfltQueue.shift() : dfltQueue[0];
    return dflt;
  };

  const exec = vi.fn(async (cmd: string, ..._rest: unknown[]) => {
    commands.push(cmd);
    const res = normalize(pick(cmd));
    if (res instanceof Error) throw res;
    return res;
  }) as FakeTransport['exec'];

  const execStream = vi.fn(async (cmd: string, options = {}) => {
    commands.push(cmd);
    const res = normalize(pick(cmd));
    if (res instanceof Error) throw res;
    if (res.stdout) await options.onStdout?.(Buffer.from(res.stdout));
    if (res.stderr) await options.onStderr?.(Buffer.from(res.stderr));
    return res.code;
  }) as FakeTransport['execStream'];

  const ping = vi.fn(async () =>
    pingQueue.length ? pingQueue.shift()! : pingSticky,
  ) as FakeTransport['ping'];

  const writeFile = vi.fn(async () => undefined) as FakeTransport['writeFile'];

  const t: FakeTransport = {
    exec,
    execStream,
    writeFile,
    ping,
    on(m, r) {
      rules.push({ match: m, sticky: r, queue: [] });
      return t;
    },
    onceOn(m, ...rs) {
      let rule = rules.find((x) => x.match === m);
      if (!rule) {
        rule = { match: m, queue: [] };
        rules.push(rule);
      }
      rule.queue.push(...rs);
      return t;
    },
    default(r) {
      dflt = r;
      return t;
    },
    defaultOnce(...rs) {
      dfltQueue.push(...rs);
      return t;
    },
    setPing(v) {
      pingSticky = v;
      return t;
    },
    oncePing(...v) {
      pingQueue.push(...v);
      return t;
    },
    get commands() {
      return commands;
    },
    reset() {
      rules.length = 0;
      dflt = undefined;
      dfltQueue.length = 0;
      pingSticky = true;
      pingQueue.length = 0;
      commands.length = 0;
      exec.mockClear();
      execStream.mockClear();
      writeFile.mockClear();
      ping.mockClear();
    },
  };
  return t;
}
