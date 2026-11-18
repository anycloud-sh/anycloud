import { z } from 'zod';
import { authenticatedEndpoints } from './base.js';
import { noInputSchema } from './common-schemas.js';
import {
  kubernetesStepInputSchema,
  kubernetesStepResponseSchema,
  requestSystemReleaseInputSchema,
  selfDeleteInputSchema,
  selfDeleteStatusSchema,
  systemBackupResponseSchema,
  systemReleaseResponseSchema,
  systemReleaseStatusSchema,
} from './system-release-schemas.js';

const authenticated = authenticatedEndpoints({}, 'System Release');

const unavailable = {
  SYSTEM_RELEASE_UNAVAILABLE: {
    status: 503,
    message: 'API release updates are not available here',
  },
} as const;

/**
 * Update of a Helm-managed API by any peer it admits: the API validates the
 * image, backs its database up, records the intent and patches its own
 * HelmChart through the cluster connection recorded on it. helm-controller
 * and the chart's pre-upgrade guard do the rest; the replacement answers
 * `status` afterwards.
 */
const request = authenticated
  .command(
    {
      method: 'POST',
      path: '/system-release',
      operationId: 'requestSystemRelease',
      summary: 'Update this API system release to an exact image',
      successStatus: 202,
    },
    // Nothing durable happens before the intent row; a 503 retry is safe.
    { replay: 'not-processed', timeoutMs: 120_000 },
  )
  .input(requestSystemReleaseInputSchema)
  .output(systemReleaseResponseSchema)
  .errors({
    SYSTEM_RELEASE_REFUSED: {
      status: 400,
      message: 'Release request does not satisfy the update contract',
    },
    SYSTEM_RELEASE_STALE: {
      status: 409,
      message: 'Release request is stale against the current release',
    },
    ...unavailable,
  });

const status = authenticated
  .query({
    method: 'GET',
    path: '/system-release',
    operationId: 'getSystemReleaseStatus',
    summary: 'Served version, latest release intent and Deployment rollout',
  })
  .input(noInputSchema)
  .output(systemReleaseStatusSchema)
  .errors(unavailable);

/**
 * RFC 0049 C26 (b): `api upgrade` has the API label the management Node and
 * bring K3s's server configuration to the release it moves to, from a
 * host-step Job on the management Node. The first call starts the step; later
 * calls with the same id report it.
 */
const kubernetes = authenticated
  .command(
    {
      method: 'POST',
      path: '/system-release/kubernetes',
      operationId: 'runKubernetesStep',
      summary: 'Reconfigure K3s on the management host for a release',
    },
    // The id names one step: a repeat reports it rather than starting another.
    { replay: 'safe', timeoutMs: 120_000 },
  )
  .input(kubernetesStepInputSchema)
  .output(kubernetesStepResponseSchema)
  .errors({
    SYSTEM_RELEASE_REFUSED: {
      status: 400,
      message: 'Release request does not satisfy the update contract',
    },
    ...unavailable,
  });

/**
 * RFC 0049 C28: `api delete` keeps the checkpoint bucket, so it first asks
 * the hosted API for the backup an upgrade takes before a release.
 */
const backup = authenticated
  .command(
    {
      method: 'POST',
      path: '/system-release/backup',
      operationId: 'backupSystemDatabase',
      summary: "Back this API's database up to its checkpoint bucket now",
      inputStructure: 'detailed',
    },
    // A repeat takes another backup; nothing else changes.
    // Under Cloudflare's 100 s proxy timeout, which fronts the hostname.
    { replay: 'safe', timeoutMs: 90_000 },
  )
  .input(z.object({}))
  .output(systemBackupResponseSchema)
  .errors(unavailable);

/**
 * `api delete` with the hosted API reachable: refused while
 * live VM workloads remain; otherwise the API takes C28's final backup,
 * answers, sweeps its VM Jobs and per-Job buckets, and deletes its own
 * stack, group or instance last.
 */
const selfDelete = authenticated
  .command(
    {
      method: 'POST',
      path: '/system-release/self-delete',
      operationId: 'requestSelfDelete',
      summary: "Delete this API's installation, the API itself last",
      successStatus: 202,
    },
    // A repeat answers with the delete already running.
    { replay: 'safe', timeoutMs: 90_000 },
  )
  .input(selfDeleteInputSchema)
  .output(selfDeleteStatusSchema)
  .errors({
    SELF_DELETE_REFUSED: {
      status: 409,
      message: 'The installation still has running workloads',
    },
    ...unavailable,
  });

const selfDeleteStatus = authenticated
  .query({
    method: 'GET',
    path: '/system-release/self-delete',
    operationId: 'getSelfDelete',
    summary: "This API's self-delete progress",
  })
  .input(noInputSchema)
  .output(selfDeleteStatusSchema)
  .errors(unavailable);

export const systemReleaseContract = {
  selfDelete,
  selfDeleteStatus,
  request,
  status,
  kubernetes,
  backup,
};
