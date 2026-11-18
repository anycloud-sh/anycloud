import { createInterface } from 'node:readline';
import type { startCanaryProcess } from './agent-canary-process';
import { isRecord, parseJsonRecord } from './json';

interface PendingResult {
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Execute sequential CLI inputs; metadata commands must report no inference. */
export function connectClaudeSession(
  process: ReturnType<typeof startCanaryProcess>,
  sessionId: string,
  { allowInference = false, timeoutMs = 15_000 } = {},
) {
  const { child } = process;
  const lines = createInterface({ input: child.stdout });
  let pending: PendingResult | undefined;
  let failure: Error | undefined;

  function fail(error: Error): void {
    failure ??= error;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(failure);
      pending = undefined;
    }
  }

  lines.on('line', (line) => {
    if (failure) return;
    try {
      const result = parseJsonRecord(line, 'Claude session message');
      if (result.type !== 'result') return;
      if (!pending || result.session_id !== sessionId)
        throw new Error('Unexpected Claude session result');
      if (result.subtype !== 'success' || result.is_error !== false) {
        throw new Error(
          `Claude input failed: ${JSON.stringify(result.errors ?? result.result ?? result.subtype)}`,
        );
      }
      if (!allowInference) {
        const { usage, modelUsage } = result;
        if (
          !isRecord(usage) ||
          [
            'input_tokens',
            'output_tokens',
            'cache_creation_input_tokens',
            'cache_read_input_tokens',
          ].some((key) => usage[key] !== 0) ||
          !isRecord(modelUsage) ||
          Object.keys(modelUsage).length !== 0 ||
          result.total_cost_usd !== 0
        ) {
          throw new Error(
            'Claude metadata command must report zero tokens, cost, and model usage',
          );
        }
      }
      const waiter = pending;
      pending = undefined;
      clearTimeout(waiter.timer);
      waiter.resolve(result);
    } catch (error) {
      fail(
        new Error(
          `Invalid Claude session result: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        ),
      );
    }
  });
  const onClose = () =>
    fail(new Error('Claude exited before the expected result'));
  const onError = (error: Error) => fail(error);
  child.once('close', onClose);
  child.on('error', onError);
  child.stdin.on('error', onError);

  function send(content: string): Promise<Record<string, unknown>> {
    if (failure) return Promise.reject(failure);
    if (pending)
      return Promise.reject(new Error('Claude input is already pending'));
    return new Promise((resolve, reject) => {
      pending = {
        resolve,
        reject,
        timer: setTimeout(
          () => fail(new Error('Claude timed out waiting for a result')),
          timeoutMs,
        ),
      };
      try {
        child.stdin.write(
          `${JSON.stringify({
            type: 'user',
            session_id: sessionId,
            message: { role: 'user', content },
            parent_tool_use_id: null,
          })}\n`,
        );
      } catch (error) {
        fail(new Error('Could not send Claude input', { cause: error }));
      }
    });
  }

  function close(): void {
    fail(new Error('Claude session client closed'));
    lines.close();
    lines.removeAllListeners();
    child.off('close', onClose);
    child.off('error', onError);
    child.stdin.off('error', onError);
  }

  return { send, close };
}
