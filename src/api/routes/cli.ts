import { Router, type Response } from 'express';
import { type StoredWorkload } from '../services/workload-record.js';
import { type ExecStreamEvent } from '../../shared/api-contract/native-schemas.js';
import { nativeRouteInventory } from '../../shared/api-contract/native-schemas.js';
import { sendError } from '../middleware/error-handler.js';
import {
  parseNativeRequest,
  sendNativeApiError,
} from '../middleware/native-validation.js';
import { validatedClientVersion } from '../middleware/client-version.js';
import { authenticatedUser } from '../middleware/validation.js';
import { resolveOwnershipScope } from '../services/repositories/api-access-policy.js';
import {
  getDeploymentStore,
  getWorkloadQueryStore,
} from '../services/persistence.js';
import type { User } from '../services/entities.js';
import {
  getDefaultWorkloadOperations,
  prepareDeploymentExec,
  prepareDeploymentLogs,
} from '../services/job/default-operations.js';
import type {
  JobExecPreparation,
  JobLogsPreparation,
  JobOperationStream,
} from '../services/job/operations.js';
import { recordEvent } from '../services/telemetry.js';
import { errorMessage } from '../../shared/log-diagnostics.js';
import type { ApiRequestTracker } from '../services/http-shutdown.js';

const EXEC_STREAM_HEARTBEAT_MS = 15_000;
const EXEC_STREAM_WRITE_TIMEOUT_MS = 30_000;

function waitForExecStreamDrain(
  res: Response,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      res.off('drain', onDrain);
      res.off('close', onClose);
      res.off('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const resolveOnce = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onDrain = () => resolveOnce();
    const onClose = () => rejectOnce(new Error('Exec stream response closed'));
    const onError = (error: Error) => rejectOnce(error);
    const onAbort = () => rejectOnce(new Error('Exec stream aborted'));
    const timer = setTimeout(
      () => rejectOnce(new Error('Exec stream write timed out')),
      timeoutMs,
    );
    timer.unref?.();

    res.once('drain', onDrain);
    res.once('close', onClose);
    res.once('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function startExecStreamResponse(res: Response, successStatus: number): void {
  res.status(successStatus);
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

export async function writeExecStreamEvent(
  res: Response,
  event: ExecStreamEvent,
  signal?: AbortSignal,
  timeoutMs = EXEC_STREAM_WRITE_TIMEOUT_MS,
): Promise<void> {
  if (res.destroyed || res.writableEnded) return;
  const line = `${JSON.stringify(event)}\n`;
  if (res.write(line)) return;
  await waitForExecStreamDrain(res, signal, timeoutMs);
}

async function streamRuntimeCommandResponse(
  res: Response,
  successStatus: number,
  run: (stream: JobOperationStream) => Promise<number>,
): Promise<{
  exitCode?: number;
  error?: string;
  stdoutBytes: number;
  stderrBytes: number;
}> {
  if (res.destroyed) {
    return { error: 'Client disconnected', stdoutBytes: 0, stderrBytes: 0 };
  }
  const abortController = new AbortController();
  let clientClosed = false;
  let writeChain: Promise<void> = Promise.resolve();
  const enqueueEvent = (event: ExecStreamEvent): Promise<void> => {
    writeChain = writeChain.then(() =>
      writeExecStreamEvent(res, event, abortController.signal),
    );
    return writeChain;
  };

  res.on('close', () => {
    if (!res.writableEnded) {
      clientClosed = true;
      abortController.abort(new Error('Client disconnected'));
    }
  });

  let heartbeat: NodeJS.Timeout | undefined;
  let exitCode: number | undefined;
  let error: string | undefined;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  try {
    startExecStreamResponse(res, successStatus);
    heartbeat = setInterval(() => {
      void enqueueEvent({ type: 'heartbeat' }).catch(() => {
        clientClosed = true;
        abortController.abort(new Error('Client disconnected'));
      });
    }, EXEC_STREAM_HEARTBEAT_MS);
    heartbeat.unref();

    exitCode = await run({
      signal: abortController.signal,
      onStdout: (chunk) => {
        stdoutBytes += chunk.length;
        return enqueueEvent({
          type: 'stdout',
          data: chunk.toString('base64'),
        });
      },
      onStderr: (chunk) => {
        stderrBytes += chunk.length;
        return enqueueEvent({
          type: 'stderr',
          data: chunk.toString('base64'),
        });
      },
    });

    if (!clientClosed) await enqueueEvent({ type: 'exit', code: exitCode });
  } catch (caught) {
    error = clientClosed ? 'Client disconnected' : errorMessage(caught);
    if (!clientClosed && !res.writableEnded) {
      try {
        await enqueueEvent({ type: 'error', error });
      } catch {
        // The client is already gone; telemetry records the failed stream.
      }
    }
  } finally {
    clearInterval(heartbeat);
    if (!res.writableEnded) {
      try {
        await writeChain;
      } catch {
        // The response already failed or closed.
      }
      res.end();
    }
  }
  return { exitCode, error, stdoutBytes, stderrBytes };
}

/** Native transport routes whose NDJSON streaming does not fit OpenAPI RPC. */
export function createCliRouter(requests: ApiRequestTracker): Router {
  const router = Router();

  router.post(nativeRouteInventory.exec.expressPath, (req, res) =>
    requests.track('native.exec', async () => {
      let user: User | undefined;
      let error: string | undefined;
      let workloadState: string | undefined;
      let loadedWorkload: StoredWorkload | undefined;
      let exitCode: number | undefined;
      const version = validatedClientVersion(res);
      const startedAt = Date.now();
      const input = parseNativeRequest(
        nativeRouteInventory.exec.requestSchema,
        { params: req.params, body: req.body },
        res,
        'EXEC_REQUEST_INVALID',
      );
      if (!input) return;
      const { id } = input.params;
      const { command, replica } = input.body;

      try {
        user = authenticatedUser(req);
        const store = getWorkloadQueryStore();
        const scope = await resolveOwnershipScope();
        const workload = await store.getWorkloadForScope(id, scope);
        // A Deployment record is not a Workload, but `exec` reaches its Pods too.
        const deployment = workload
          ? null
          : await getDeploymentStore().getForScope(id, scope);
        if (workload && replica) {
          sendNativeApiError(
            res,
            400,
            'EXEC_REQUEST_INVALID',
            '--replica applies only to a Deployment.',
          );
          error = 'Replica for a Workload';
          return;
        }
        let prepared: JobExecPreparation;
        if (workload) {
          loadedWorkload = workload;
          workloadState = workload.state;
          prepared = await getDefaultWorkloadOperations(workload).prepareExec({
            workload,
            allVms: await store.listVms(id),
            command,
          });
        } else if (deployment) {
          workloadState = 'deployment';
          prepared = await prepareDeploymentExec(deployment, command, replica);
        } else {
          sendNativeApiError(
            res,
            404,
            'WORKLOAD_MANAGEMENT_NOT_FOUND',
            'Workload or Deployment not found',
          );
          error = 'Workload not found';
          workloadState = 'not_found';
          return;
        }
        if (!prepared.ok) {
          sendNativeApiError(
            res,
            prepared.status,
            'WORKLOAD_OPERATION_FAILED',
            prepared.clientError,
          );
          error = prepared.telemetryError;
          return;
        }
        const result = await streamRuntimeCommandResponse(
          res,
          nativeRouteInventory.exec.successStatus,
          (stream) => prepared.run(stream),
        );
        exitCode = result.exitCode;
        if (result.error) error = result.error;
      } catch (caught) {
        error = errorMessage(caught);
        sendError(res, caught, {
          code: 'WORKLOAD_OPERATION_FAILED',
          version,
          id,
          user,
        });
      } finally {
        if (user) {
          recordEvent(user, 'exec', {
            version,
            durationMs: Date.now() - startedAt,
            id,
            ...(exitCode !== undefined && { exitCode }),
            ...(error && { error }),
            ...(workloadState && { workloadState }),
            ...(loadedWorkload && {
              cloudProvider: loadedWorkload.cloudProvider,
              region: loadedWorkload.region,
              vmType: loadedWorkload.vmType,
              gpuType: loadedWorkload.gpuType,
            }),
          });
        }
      }
    }),
  );

  router.get(nativeRouteInventory.logs.expressPath, (req, res) =>
    requests.track('native.logs', async () => {
      let user: User | undefined;
      let error: string | undefined;
      let workloadState: string | undefined;
      let loadedWorkload: StoredWorkload | undefined;
      let exitCode: number | undefined;
      let stdoutBytes: number | undefined;
      let stderrBytes: number | undefined;
      let logsTargetContainerStatus: string | undefined;
      let logsProbeCount: number | undefined;
      const version = validatedClientVersion(res);
      const startedAt = Date.now();
      const input = parseNativeRequest(
        nativeRouteInventory.logs.requestSchema,
        { params: req.params, query: req.query },
        res,
        'LOGS_REQUEST_INVALID',
      );
      if (!input) return;
      const { id } = input.params;
      const { follow } = input.query;

      try {
        user = authenticatedUser(req);
        const store = getWorkloadQueryStore();
        const scope = await resolveOwnershipScope();
        const workload = await store.getWorkloadForScope(id, scope);
        // A Deployment record is not a Workload, but `logs` reads its Pods too.
        const deployment = workload
          ? null
          : await getDeploymentStore().getForScope(id, scope);
        let prepared: JobLogsPreparation;
        if (workload) {
          loadedWorkload = workload;
          workloadState = workload.state;
          prepared = await getDefaultWorkloadOperations(workload).prepareLogs({
            workload,
            allVms: await store.listVms(id),
            follow: Boolean(follow),
          });
        } else if (deployment) {
          workloadState = 'deployment';
          prepared = await prepareDeploymentLogs(deployment, Boolean(follow));
        } else {
          sendNativeApiError(
            res,
            404,
            'WORKLOAD_MANAGEMENT_NOT_FOUND',
            'Workload or Deployment not found',
          );
          error = 'Workload not found';
          workloadState = 'not_found';
          return;
        }

        logsProbeCount = prepared.probeCount;
        logsTargetContainerStatus = prepared.targetContainerStatus;
        if (!prepared.ok) {
          sendNativeApiError(
            res,
            prepared.status,
            prepared.code ?? 'WORKLOAD_OPERATION_FAILED',
            prepared.clientError,
          );
          error = prepared.telemetryError;
          return;
        }

        const result = await streamRuntimeCommandResponse(
          res,
          nativeRouteInventory.logs.successStatus,
          (stream) => prepared.run(stream),
        );
        exitCode = result.exitCode;
        stdoutBytes = result.stdoutBytes;
        stderrBytes = result.stderrBytes;
        if (result.error) error = result.error;
      } catch (caught) {
        error = errorMessage(caught);
        sendError(res, caught, {
          code: 'WORKLOAD_OPERATION_FAILED',
          version,
          id,
          user,
        });
      } finally {
        if (user) {
          recordEvent(user, 'logs', {
            version,
            durationMs: Date.now() - startedAt,
            id,
            ...(exitCode !== undefined && { exitCode }),
            ...(error && { error }),
            ...(stdoutBytes !== undefined && { stdoutBytes }),
            ...(stderrBytes !== undefined && { stderrBytes }),
            ...(logsTargetContainerStatus && { logsTargetContainerStatus }),
            ...(logsProbeCount !== undefined && { logsProbeCount }),
            ...(workloadState && { workloadState }),
            ...(loadedWorkload && {
              cloudProvider: loadedWorkload.cloudProvider,
              region: loadedWorkload.region,
              vmType: loadedWorkload.vmType,
              gpuType: loadedWorkload.gpuType,
            }),
          });
        }
      }
    }),
  );

  return router;
}
