import { createInterface } from 'node:readline';
import type { startCanaryProcess } from './agent-canary-process';
import { isRecord, parseJsonRecord } from './json';

const RPC_TIMEOUT_MS = 15_000;

type Message = Record<string, unknown>;
interface Waiter {
  matches: (message: Message) => boolean;
  resolve: (message: Message) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Minimal JSONL RPC client for the title canary; it never starts model turns. */
export function connectCodexAppServer(
  process: ReturnType<typeof startCanaryProcess>,
  timeoutMs = RPC_TIMEOUT_MS,
) {
  const { child } = process;
  const lines = createInterface({ input: child.stdout });
  const backlog: Message[] = [];
  const waiters = new Set<Waiter>();
  let nextId = 0;
  let failure: Error | undefined;

  function fail(error: Error): void {
    failure ??= error;
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(failure);
    }
    waiters.clear();
    backlog.length = 0;
  }

  lines.on('line', (line) => {
    if (failure) return;
    try {
      const message = parseJsonRecord(line, 'Codex app-server message');
      const waiter = [...waiters].find((entry) => entry.matches(message));
      if (waiter) {
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        waiter.resolve(message);
      } else {
        if (backlog.length >= 1000)
          throw new Error('Codex notification backlog exceeded');
        backlog.push(message);
      }
    } catch (error) {
      fail(new Error('Invalid Codex app-server message', { cause: error }));
    }
  });
  const onClose = () =>
    fail(new Error('Codex app-server exited before the expected response'));
  const onError = (error: Error) => fail(error);
  child.once('close', onClose);
  child.on('error', onError);
  child.stdin.on('error', onError);

  function waitFor(
    matches: Waiter['matches'],
    description: string,
  ): Promise<Message> {
    if (failure) return Promise.reject(failure);
    const index = backlog.findIndex(matches);
    if (index >= 0) return Promise.resolve(backlog.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        matches,
        resolve,
        reject,
        timer: setTimeout(() => {
          waiters.delete(waiter);
          reject(
            new Error(`Codex app-server timed out waiting for ${description}`),
          );
        }, timeoutMs),
      };
      waiters.add(waiter);
    });
  }

  function notify(method: string, params: Message = {}): void {
    if (failure) throw failure;
    child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  async function request(method: string, params: Message): Promise<Message> {
    const id = ++nextId;
    const response = waitFor((message) => message.id === id, method);
    // Install the waiter before writing: fast responses can arrive immediately.
    try {
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    } catch (error) {
      fail(new Error(`Could not send ${method}`, { cause: error }));
    }
    const message = await response;
    if (message.error !== undefined) {
      throw new Error(
        `Codex ${method} failed: ${JSON.stringify(message.error)}`,
      );
    }
    if (!isRecord(message.result))
      throw new Error(`Invalid ${method} response`);
    return message.result;
  }

  function notification(
    method: string,
    threadId: string,
    matches: (params: Message) => boolean = () => true,
  ): Promise<Message> {
    return waitFor(
      (message) =>
        message.method === method &&
        isRecord(message.params) &&
        message.params.threadId === threadId &&
        matches(message.params),
      method,
    ).then((message) => {
      if (!isRecord(message.params))
        throw new Error(`Invalid ${method} notification`);
      return message.params;
    });
  }

  function close(): void {
    fail(new Error('Codex app-server client closed'));
    lines.close();
    lines.removeAllListeners();
    child.off('close', onClose);
    child.off('error', onError);
    child.stdin.off('error', onError);
  }

  return { request, notify, notification, close };
}
