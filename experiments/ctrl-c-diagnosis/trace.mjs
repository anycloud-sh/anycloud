import { openSync, writeSync } from 'node:fs';

// Loaded only by a disposable diagnostic artifact. No stdin reads or additional
// signal listeners are installed. A baseline without this module is required.
const path = process.env.CTRL_C_DIAG_TRACE;
if (path) install(path);

function install(tracePath) {
  const fd = openSync(tracePath, 'a', 0o600);
  let observedStdin;
  let checkpoint = 'startup';
  let activeWait;
  const resources = () => {
    try {
      return process.getActiveResourcesInfo?.();
    } catch {
      return undefined;
    }
  };
  const state = () =>
    observedStdin
      ? {
          isTTY: observedStdin.isTTY,
          isRaw: observedStdin.isRaw,
          flowing: observedStdin.readableFlowing,
          paused: observedStdin.isPaused(),
          dataListeners: observedStdin.listenerCount('data'),
          keypressListeners: observedStdin.listenerCount('keypress'),
        }
      : { accessed: false };
  const caller = () => new Error().stack?.split('\n').slice(3, 8);
  const trace = (event, detail = {}) => {
    try {
      writeSync(
        fd,
        JSON.stringify({
          at: Date.now(),
          monotonicNs: process.hrtime.bigint().toString(),
          pid: process.pid,
          event,
          checkpoint,
          activeWait,
          stdin: state(),
          ...detail,
        }) + '\n',
      );
    } catch {
      /* Diagnostics must not change application control flow. */
    }
  };
  globalThis[Symbol.for('anycloud.ctrlC.diagnostic')] = (event, detail) => {
    checkpoint = event;
    if (event.endsWith('.wait')) activeWait = event;
    if (
      event.endsWith('.done') ||
      ['work.resolved', 'work.rejected', 'work.finally'].includes(event)
    )
      activeWait = undefined;
    trace(event, detail);
  };
  // An unreferenced timer cannot keep the CLI alive. It makes a post-cleanup
  // resource leak observable without installing another process exit handler.
  setInterval(
    () => trace('diagnostic.heartbeat', { activeResources: resources() }),
    500,
  ).unref();
  trace('diagnostic.loaded', {
    node: process.version,
    bun: process.versions.bun,
  });
  const processEmit = process.emit;
  process.emit = function (event, ...args) {
    if (
      ['SIGINT', 'SIGTERM', 'SIGCONT', 'SIGTSTP', 'SIGTTIN'].includes(event)
    ) {
      trace('process.signal', {
        signal: event,
        listeners: process.listenerCount(event),
      });
    }
    if (event === 'beforeExit' || event === 'exit') {
      trace(`process.${event}`, {
        code: args[0],
        activeResources: resources(),
      });
    }
    return processEmit.call(this, event, ...args);
  };
  for (const method of ['on', 'once', 'addListener', 'off', 'removeListener']) {
    const original = process[method];
    process[method] = function (event, listener) {
      if (typeof event === 'string' && event.startsWith('SIG')) {
        trace(`process.${method}`, {
          signal: event,
          listener: listener.name,
          caller: caller(),
        });
      }
      return original.call(this, event, listener);
    };
  }
  const processExit = process.exit;
  process.exit = function (code) {
    trace('process.exit.called', { code, activeResources: resources() });
    return processExit.call(this, code);
  };
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');
  const seen = new WeakSet();
  const observeStdin = (stdin) => {
    if (seen.has(stdin)) return stdin;
    seen.add(stdin);
    observedStdin = stdin;
    trace('stdin.accessed');
    for (const method of ['pause', 'resume', 'setRawMode', 'destroy']) {
      const original = stdin[method];
      if (typeof original !== 'function') continue;
      stdin[method] = function (...args) {
        trace(`stdin.${method}.before`, {
          mode: method === 'setRawMode' ? args[0] : undefined,
          caller: caller(),
        });
        const result = original.apply(this, args);
        trace(`stdin.${method}.after`);
        return result;
      };
    }
    for (const method of [
      'on',
      'once',
      'addListener',
      'off',
      'removeListener',
    ]) {
      const original = stdin[method];
      stdin[method] = function (event, listener) {
        if (['data', 'keypress', 'readable', 'end'].includes(event)) {
          trace(`stdin.${method}`, {
            inputEvent: event,
            listener: listener.name,
            caller: caller(),
          });
        }
        return original.call(this, event, listener);
      };
    }
    const emit = stdin.emit;
    stdin.emit = function (event, ...args) {
      if (event === 'data') {
        const chunk = args[0];
        let etx = 0;
        if (typeof chunk === 'string') {
          for (const character of chunk)
            if (character.charCodeAt(0) === 3) etx++;
        } else if (chunk instanceof Uint8Array) {
          for (const byte of chunk) if (byte === 3) etx++;
        }
        trace('stdin.data', { length: chunk?.length, etx });
      }
      if (event === 'keypress' && args[1]?.ctrl && args[1]?.name === 'c') {
        trace('stdin.keypress.ctrlC');
      }
      return emit.call(this, event, ...args);
    };
    return stdin;
  };
  if (stdinDescriptor?.get && stdinDescriptor.configurable) {
    Object.defineProperty(process, 'stdin', {
      ...stdinDescriptor,
      get() {
        return observeStdin(stdinDescriptor.get.call(process));
      },
    });
  } else if (stdinDescriptor?.value) {
    observeStdin(stdinDescriptor.value);
  }
  const abort = AbortController.prototype.abort;
  AbortController.prototype.abort = function (...args) {
    trace('controller.abort', { reason: args[0]?.name, caller: caller() });
    return abort.apply(this, args);
  };
  const fetch = globalThis.fetch;
  globalThis.fetch = function (input, options) {
    let pathname;
    try {
      pathname = new URL(
        typeof input === 'string' || input instanceof URL ? input : input.url,
      ).pathname;
    } catch {
      pathname = '<unknown>';
    }
    trace('fetch.start', { pathname, aborted: options?.signal?.aborted });
    return fetch.call(this, input, options).then(
      (response) => {
        trace('fetch.response', { pathname, status: response.status });
        return response;
      },
      (error) => {
        trace('fetch.error', { pathname, error: error?.name });
        throw error;
      },
    );
  };
}
