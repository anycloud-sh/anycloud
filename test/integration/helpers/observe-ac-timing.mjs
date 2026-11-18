#!/usr/bin/env node

import { rename, writeFile } from 'node:fs/promises';
import {
  WorkloadStatusHttpError,
  TerminalWorkloadWithoutMarkerError,
  requireWorkloadStillActive,
} from './observe-ac-timing-status.mjs';

function usage(message) {
  if (message) console.error(message);
  console.error(
    'Usage: observe-ac-timing.mjs --api-url URL --workload-id ID --run-id ID --output FILE [--timeout-ms MS]',
  );
  process.exit(2);
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined)
      usage('Invalid arguments');
    values.set(key.slice(2), value);
  }
  for (const key of ['api-url', 'workload-id', 'run-id', 'output']) {
    if (!values.get(key)) usage(`Missing --${key}`);
  }
  const timeoutMs = Number(values.get('timeout-ms') ?? '1800000');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    usage('--timeout-ms must be a positive integer');
  }
  return {
    apiUrl: values.get('api-url').replace(/\/$/, ''),
    workloadId: values.get('workload-id'),
    runId: values.get('run-id'),
    output: values.get('output'),
    timeoutMs,
  };
}

const args = parseArgs(process.argv.slice(2));
const accessToken = process.env.ANYCLOUD_OBSERVER_ACCESS_TOKEN;
const version = process.env.ANYCLOUD_OBSERVER_VERSION;
if (!accessToken || !version) {
  usage(
    'ANYCLOUD_OBSERVER_ACCESS_TOKEN and ANYCLOUD_OBSERVER_VERSION are required',
  );
}

const result = {
  schemaVersion: 2,
  observationSource: 'ci-api-log-stream',
  deliveryLatencyIncluded: true,
  workloadId: args.workloadId,
  runId: args.runId,
  phase: 'armed',
  observerArmedAtMs: Date.now(),
  logStreamAttachedAtMs: null,
  firstInferenceLogObservedAtMs: null,
  terminalState: null,
  marker: null,
  transientResponses: [],
  streamAttempts: 0,
  malformedTimingLineCount: 0,
};

async function writeResult() {
  const temporary = `${args.output}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, args.output);
}

function recordTransient(status, message) {
  result.transientResponses.push({
    observedAtMs: Date.now(),
    status,
    message: String(message).replace(/\s+/g, ' ').slice(0, 240),
  });
  if (result.transientResponses.length > 40) result.transientResponses.shift();
}

function timingPayload(line) {
  if (!line.startsWith('AC_TIMING ')) return null;
  try {
    const payload = JSON.parse(line.slice('AC_TIMING '.length));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      result.malformedTimingLineCount += 1;
      return null;
    }
    return payload;
  } catch {
    result.malformedTimingLineCount += 1;
    return null;
  }
}

function makeLineConsumer(onMatch) {
  const decoders = {
    stdout: new TextDecoder(),
    stderr: new TextDecoder(),
  };
  const buffers = { stdout: '', stderr: '' };

  return (stream, bytes) => {
    buffers[stream] += decoders[stream].decode(bytes, { stream: true });
    let newline = buffers[stream].indexOf('\n');
    while (newline !== -1) {
      const line = buffers[stream].slice(0, newline).replace(/\r$/, '');
      buffers[stream] = buffers[stream].slice(newline + 1);
      const payload = timingPayload(line);
      if (
        payload?.name === 'first_inference_done' &&
        payload?.runId === args.runId
      ) {
        onMatch(payload, stream);
        return true;
      }
      newline = buffers[stream].indexOf('\n');
    }
    return false;
  };
}

async function observeStream(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The API log stream returned no response body');

  const ndjsonDecoder = new TextDecoder();
  let ndjson = '';
  let matched = false;
  const consumeLines = makeLineConsumer((payload, stream) => {
    if (matched) return;
    matched = true;
    result.firstInferenceLogObservedAtMs = Date.now();
    result.marker = { stream, payload };
  });

  const handleEvent = (line) => {
    if (!line) return;
    const event = JSON.parse(line);
    if (event.type === 'stdout' || event.type === 'stderr') {
      if (typeof event.data !== 'string') {
        throw new Error(`Invalid ${event.type} workload-log event`);
      }
      consumeLines(event.type, Buffer.from(event.data, 'base64'));
      return;
    }
    if (event.type === 'error') {
      throw new Error(
        String(event.error ?? 'Unknown workload-log stream error'),
      );
    }
    if (event.type !== 'heartbeat' && event.type !== 'exit') {
      throw new Error(`Unknown workload-log event type: ${String(event.type)}`);
    }
  };

  try {
    while (!matched) {
      const { done, value } = await reader.read();
      if (done) break;
      ndjson += ndjsonDecoder.decode(value, { stream: true });
      let newline = ndjson.indexOf('\n');
      while (newline !== -1) {
        const line = ndjson.slice(0, newline).replace(/\r$/, '');
        ndjson = ndjson.slice(newline + 1);
        handleEvent(line);
        if (matched) break;
        newline = ndjson.indexOf('\n');
      }
    }
  } finally {
    if (matched) await reader.cancel().catch(() => {});
  }
  return matched;
}

const retryableStatuses = new Set([400, 404, 409, 429, 500, 502, 503, 504]);
const deadline = result.observerArmedAtMs + args.timeoutMs;

async function failIfWorkloadTerminal() {
  const controller = new AbortController();
  const remainingMs = Math.max(1, deadline - Date.now());
  const requestTimer = setTimeout(
    () => controller.abort(),
    Math.min(10_000, remainingMs),
  );
  requestTimer.unref?.();
  try {
    await requireWorkloadStillActive({
      apiUrl: args.apiUrl,
      workloadId: args.workloadId,
      accessToken,
      version,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof TerminalWorkloadWithoutMarkerError) {
      result.terminalState = error.state;
      throw error;
    }
    if (error instanceof WorkloadStatusHttpError && error.retryable === false) {
      throw error;
    }
    recordTransient(
      error instanceof WorkloadStatusHttpError ? error.status : null,
      `status check: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(requestTimer);
  }
}

await writeResult();

try {
  // eslint-disable-next-line local/no-hand-written-retry-loops -- A standalone Node child process that cannot import the TypeScript Waiter.
  while (Date.now() < deadline) {
    result.streamAttempts += 1;
    const controller = new AbortController();
    const requestTimer = setTimeout(
      () => controller.abort(),
      Math.min(180_000, Math.max(1, deadline - Date.now())),
    );
    requestTimer.unref?.();
    try {
      const response = await fetch(
        `${args.apiUrl}/v1/workloads/${encodeURIComponent(args.workloadId)}/logs?follow=true`,
        {
          headers: {
            Accept: 'application/x-ndjson',
            Authorization: `Bearer ${accessToken}`,
            'AnyCloud-Client-Version': version,
          },
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        const message = await response.text();
        if (!retryableStatuses.has(response.status)) {
          throw new Error(
            `Workload logs returned non-retryable HTTP ${response.status}: ${message.slice(0, 240)}`,
          );
        }
        recordTransient(response.status, message);
      } else {
        if (result.logStreamAttachedAtMs === null) {
          result.logStreamAttachedAtMs = Date.now();
          result.phase = 'attached';
          await writeResult();
        }
        if (await observeStream(response)) {
          result.phase = 'observed';
          await writeResult();
          process.exit(0);
        }
        recordTransient(200, 'log stream ended before the expected marker');
      }
    } catch (error) {
      if (error instanceof Error && /non-retryable HTTP/.test(error.message)) {
        throw error;
      }
      recordTransient(
        null,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      clearTimeout(requestTimer);
    }

    // A failed provisioning attempt may never expose a container log stream,
    // while a workload that exits before the marker closes that stream. In
    // either case, consult the authoritative workload state before retrying
    // so a terminal workload does not consume the observer's full timeout.
    await failIfWorkloadTerminal();

    if (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw new Error(
    `Timed out after ${args.timeoutMs}ms waiting for first inference`,
  );
} catch (error) {
  result.phase = 'failed';
  result.error = error instanceof Error ? error.message : String(error);
  await writeResult();
  console.error(result.error);
  process.exit(1);
}
