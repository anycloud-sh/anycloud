import {
  handOffE2eAccess,
  waitForFile,
} from './services/e2e-access-handoff.js';
import { startBackups } from './services/first-backup.js';
import { backupStorage } from './services/gateways/instance-backup-storage.js';
import express, { type RequestHandler } from 'express';
import { dirname, join } from 'path';
import { existsSync, mkdirSync, renameSync, readFileSync } from 'fs';
import config, {
  getApiBackupConfig,
  getE2eAccessKubeconfigPath,
  getHostedClusterConfig,
  getWorkloadApiUrl,
  isHelmManagedApi,
} from './config.js';
import {
  getDefaultApiDatabaseBackup,
  getDefaultFirstBackupCheck,
} from './services/api-database-backup-default.js';
import type {
  HostedSystemReleaseIdentity,
  SystemReleaseDomain,
} from './services/system-release-domain.js';
import {
  hostedClusterEnvironment,
  recordHostedCluster,
} from './services/cluster-self-record.js';
import { observeClusterIdentity } from './services/kubernetes/cluster-identity.js';
import {
  inClusterServiceAccountIssuerDocuments,
  SERVICE_ACCOUNT_ISSUER_DISCOVERY_PATH,
  type ServiceAccountIssuerDocuments,
} from './services/kubernetes/service-account-issuer.js';
import { SERVICE_ACCOUNT_ISSUER_JWKS_PATH } from '../shared/system-release.js';
import {
  createRoleSetupDocuments,
  issuerThumbprint,
  type RoleSetupDocuments,
} from './services/role-connection-setup-templates.js';
import {
  ROLE_SETUP_PATHS,
  type RoleSetupCloud,
} from '../shared/role-connection-setup.js';
import { API_SERVICE_ACCOUNT_SUBJECT } from './services/kubernetes/service-account-token.js';
import { log } from './services/logger.js';
import { shutdownTelemetry } from './services/telemetry.js';
import { expressErrorHandler } from './middleware/error-handler.js';
import { requireCompatibleClientVersion } from './middleware/client-version.js';
import { createAuthenticationMiddleware } from './middleware/validation.js';
import { sendNativeApiError } from './middleware/native-validation.js';
import { createCliRouter } from './routes/cli.js';
import { createBucketRouter } from './routes/bucket.js';
import { createApiRpcMiddleware } from './rpc/express.js';
import {
  createApiRpcDomains,
  createHostedSystemRelease,
} from './composition.js';
import { type ApiRpcDomains } from './rpc/context.js';
import {
  closePersistence,
  initializePersistence,
  getPersistence,
  getSchemaAppVersion,
  recordApiVersion,
} from './services/persistence.js';
import { importLegacyNotificationsConfig } from './services/notifications-legacy-import.js';
import { upsertApiAccessOwner } from './services/repositories/api-access-policy.js';
import {
  startBackgroundServices,
  stopBackgroundServices,
} from './services/monitor.js';
import { refreshCatalogs } from './services/catalog-readiness.js';
import { getAnycloudDir, sleep } from '../shared/utils.js';
import { errorMessage } from '../shared/log-diagnostics.js';
import { isLoopbackApiUrl } from '../shared/config.js';
import { hostedApiOwnerFromArgv } from '../shared/hosted-api.js';
import {
  API_NOTIFICATION_LABEL_ENV,
  hostedApiNotificationLabel,
} from '../shared/notifications/source.js';
import { diagnosticRouteInventory } from '../shared/api-contract/native-schemas.js';
import { getApiIdentity, resolveApiIdentity } from './services/api-identity.js';
import {
  authenticateApiToken,
  createLocalApiAuthentication,
  localOwnerId,
  readLocalApiToken,
  type AuthenticateApiRequest,
} from './services/api-authentication.js';
import {
  startApiOwnershipBackfill,
  stopApiOwnershipBackfill,
} from './services/api-ownership-backfill.js';
import { shutdownSshProcesses } from './services/gateways/ssh-process.js';
import {
  createApiRequestTracker,
  createApiShutdown,
  type ApiRequestTracker,
} from './services/http-shutdown.js';

// ============================================================================
// Express App Factory
// ============================================================================

export interface CreateAppOptions {
  shutdownSignal?: AbortSignal;
  requests?: ApiRequestTracker;
  hostedSystemRelease?: HostedSystemReleaseIdentity;
  /** A hosted API serves its cluster's ServiceAccount issuer, unauthenticated. */
  serviceAccountIssuer?: ServiceAccountIssuerDocuments;
  /** Role connection setup templates trusting that issuer, unauthenticated. */
  roleSetup?: RoleSetupDocuments;
  /** Test seam for replacing persistence while one HTTP listener remains live. */
  resolveRpcDomains?: () => ApiRpcDomains;
  /** API tokens on a hosted API, the per-install token on a local one. */
  authenticate: AuthenticateApiRequest;
}

const preventControlPlaneCaching: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};

export function createApp(options: CreateAppOptions) {
  const app = express();
  const requests = options.requests ?? createApiRequestTracker();
  const { authenticate } = options;
  app.use((_req, res, next) => {
    if (requests.draining) {
      // Declared in every contract procedure: nothing ran, so clients retry.
      res.setHeader('Connection', 'close');
      res.setHeader('Retry-After', '1');
      sendNativeApiError(
        res,
        503,
        'API_RESTARTING',
        'API server is restarting',
      );
      return;
    }
    next();
  });

  // Health check
  app.get(diagnosticRouteInventory.health.expressPath, (_req, res) => {
    res.status(diagnosticRouteInventory.health.successStatus).send('ok');
  });

  app.get(diagnosticRouteInventory.version.expressPath, (_req, res) => {
    // The schema version is what an older image would refuse to start
    // against; release tooling reads it before choosing a target.
    getSchemaAppVersion()
      .catch(() => null)
      .then((schemaVersion) => {
        res.status(diagnosticRouteInventory.version.successStatus).json({
          version: config.currVersion,
          previousVersion: config.previousVersion,
          schemaVersion,
        });
      });
  });

  const issuer = options.serviceAccountIssuer;
  if (issuer) {
    // The clouds read these while validating a role connection's token
    // (Azure at every exchange), so nothing may cache an old signing key.
    const serve =
      (read: () => Promise<unknown>, contentType: string): RequestHandler =>
      (_req, res, next) => {
        read().then((document) => {
          res.setHeader('Cache-Control', 'no-store');
          res.type(contentType).send(JSON.stringify(document));
        }, next);
      };
    app.get(
      SERVICE_ACCOUNT_ISSUER_DISCOVERY_PATH,
      serve(() => issuer.discovery(), 'application/json'),
    );
    app.get(
      SERVICE_ACCOUNT_ISSUER_JWKS_PATH,
      serve(() => issuer.jwks(), 'application/jwk-set+json'),
    );
  }
  const roleSetup = options.roleSetup;
  if (roleSetup) {
    for (const [cloud, path] of Object.entries(ROLE_SETUP_PATHS))
      app.get(path, (_req, res, next) => {
        roleSetup(cloud as RoleSetupCloud).then(({ contentType, body }) => {
          res.setHeader('Cache-Control', 'no-store');
          // The Azure portal fetches its template from the browser.
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.type(contentType).send(body);
        }, next);
      });
  }

  if (process.env.IS_TEST === 'true') {
    app.get('/__test/memory', (_req, res) => {
      res.json(createMemorySnapshot());
    });
  }

  // Operational responses are user-specific and often sensitive. Public
  // diagnostics above remain cache-neutral; NDJSON routes replace this with
  // their stream-specific directive.
  app.use('/v1', preventControlPlaneCaching);

  // Contract-backed JSON endpoints own their parsing and validation. This must
  // stay before Express's JSON parser; unmatched native streaming routes
  // continue below without their request bodies being consumed.
  app.use(
    createApiRpcMiddleware({
      shutdownSignal: options.shutdownSignal,
      requests,
      authenticate,
      domains:
        options.resolveRpcDomains ??
        createApiRpcDomains({
          ...(options.hostedSystemRelease
            ? { hostedSystemRelease: options.hostedSystemRelease }
            : {}),
        }),
    }),
  );

  app.use(express.json());

  // Native streams share one version/authentication boundary. Mounting that
  // middleware inside sibling routers would execute it again on fallthrough.
  app.use(
    '/v1',
    requireCompatibleClientVersion,
    createAuthenticationMiddleware(
      requests,
      options.shutdownSignal,
      authenticate,
    ),
    createCliRouter(requests),
    createBucketRouter(requests),
  );

  // Error middleware - must be last, after all routes
  app.use(expressErrorHandler);

  return app;
}

function readCgroupMemoryBytes(): number | null {
  for (const path of [
    '/sys/fs/cgroup/memory.current',
    '/sys/fs/cgroup/memory/memory.usage_in_bytes',
  ]) {
    try {
      const value = Number(readFileSync(path, 'utf8').trim());
      if (Number.isFinite(value) && value >= 0) return value;
    } catch {
      // Not running in a cgroup/container, or the host uses another layout.
    }
  }
  return null;
}

export function createMemorySnapshot() {
  const memory = process.memoryUsage();

  return {
    timestampMs: Date.now(),
    uptimeSec: process.uptime(),
    rssBytes: memory.rss,
    heapTotalBytes: memory.heapTotal,
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
    cgroupMemoryBytes: readCgroupMemoryBytes(),
  };
}

// ============================================================================
// Process-Level Error Handlers
// ============================================================================

/**
 * Sets up process-level error handlers for graceful degradation.
 * Exported for testability.
 */
export function setupProcessHandlers() {
  process.on('uncaughtException', (error: Error) => {
    log.error('Uncaught exception - shutting down gracefully', {
      id: 'system',
      error: error.message,
      stack: error.stack,
    });
    // Give time to flush logs before exiting
    setTimeout(() => {
      process.exit(1);
    }, 1000);
  });

  process.on('unhandledRejection', (reason: any, _promise: Promise<any>) => {
    log.error('Unhandled promise rejection', {
      id: 'system',
      error: reason?.message || String(reason),
      stack: reason?.stack,
    });
  });
}

// ============================================================================
// Server Startup (only when run directly)
// ============================================================================

const PORT = parseInt(config.port ?? '3000', 10);

export function initializeSqlitePathForServer(): void {
  if (!process.env.SQLITE_PATH) {
    const anycloudDir = getAnycloudDir();
    mkdirSync(anycloudDir, { recursive: true, mode: 0o700 });
    const legacyPath = join(anycloudDir, 'conductor.db');
    const newPath = join(anycloudDir, 'api.db');
    // Migrate legacy DB filename from conductor.db to api.db
    if (existsSync(legacyPath) && !existsSync(newPath)) {
      renameSync(legacyPath, newPath);
    }
    process.env.SQLITE_PATH = newPath;
    return;
  }

  if (process.env.SQLITE_PATH !== ':memory:') {
    const parent = dirname(process.env.SQLITE_PATH);
    if (parent !== '.') {
      mkdirSync(parent, { recursive: true, mode: 0o700 });
    }
  }
}

/** A hosted API must advertise an origin its Kubernetes Pods can reach. */
export function validateHostedWorkloadApiUrl(
  hosted: boolean,
  workloadApiUrl = getWorkloadApiUrl(),
): void {
  if (!hosted) return;
  if (isLoopbackApiUrl(workloadApiUrl)) {
    throw new Error(
      'Hosted API requires ANYCLOUD_WORKLOAD_API_URL to be an externally reachable HTTP(S) origin',
    );
  }
}

// Only start server if this file is run directly (not imported)
if (import.meta.url === `file://${process.argv[1]}`) {
  setupProcessHandlers();

  initializeSqlitePathForServer();

  const hostedApiOwner = hostedApiOwnerFromArgv(process.argv.slice(2));
  const hostedApiWorkloadId = process.env.WORKLOAD_ID?.trim();
  validateHostedWorkloadApiUrl(hostedApiOwner !== undefined);
  // IS_TEST stubs GitHub identities.
  if (hostedApiOwner && process.env.IS_TEST === 'true') {
    throw new Error('A hosted API (--hosted-api-owner) refuses IS_TEST');
  }
  // A local API refuses to start without the token `api start` writes.
  const localApiToken = hostedApiOwner ? undefined : await readLocalApiToken();
  const apiIdentity = resolveApiIdentity({
    hosted: hostedApiOwner !== undefined,
    workloadId: hostedApiWorkloadId,
  });
  if (hostedApiOwner && hostedApiWorkloadId) {
    process.env[API_NOTIFICATION_LABEL_ENV] = hostedApiNotificationLabel(
      hostedApiWorkloadId,
      hostedApiOwner.username,
    );
  }
  await initializePersistence(apiIdentity);
  // Extend the api_versions timeline before any work runs under this version.
  // Attribution must not block serving; a failed write costs one timeline row.
  try {
    await recordApiVersion(config.currVersion);
  } catch (error) {
    log.warn('Failed to record API version', { id: 'system', error: error });
  }
  // Runs at most once per database. A failure here must not stop the API from
  // serving: the operator can always re-enable the channel.
  try {
    await importLegacyNotificationsConfig();
  } catch (error) {
    log.warn('Failed to import legacy notification settings', {
      id: 'system',
      error: error,
    });
  }
  if (hostedApiOwner) {
    await upsertApiAccessOwner(
      hostedApiOwner.username,
      hostedApiOwner.ownerUserId,
    );
  }

  // Only the Helm-managed system release carries the chart-set marker; the
  // legacy Docker-hosted API keeps its owner and WORKLOAD_ID but gets
  // SYSTEM_RELEASE_UNAVAILABLE from the release surface.
  const hostedSystemRelease: HostedSystemReleaseIdentity | undefined =
    hostedApiOwner && hostedApiWorkloadId && isHelmManagedApi()
      ? { installationId: hostedApiWorkloadId }
      : undefined;
  // The hosted API records the cluster it runs in before serving; a control
  // plane other than the one bootstrap observed refuses the start (the error
  // propagates and the process exits).
  if (hostedSystemRelease && hostedApiOwner) {
    const recorded = await recordHostedCluster({
      clusterId: hostedSystemRelease.installationId,
      ownerUserId: hostedApiOwner.ownerUserId,
      environment: hostedClusterEnvironment(getHostedClusterConfig()),
      installations: getPersistence().clusters,
      observeKubernetesIdentity: (connection) =>
        observeClusterIdentity(connection),
    });
    log.info('Hosted API cluster record', {
      id: 'system',
      clusterId: hostedSystemRelease.installationId,
      recorded,
    });
  }
  const requestShutdown = new AbortController();
  const requests = createApiRequestTracker();
  const app = createApp({
    shutdownSignal: requestShutdown.signal,
    requests,
    ...(hostedSystemRelease
      ? {
          hostedSystemRelease,
          ...hostedIssuer(),
        }
      : {}),
    authenticate:
      localApiToken === undefined
        ? authenticateApiToken
        : createLocalApiAuthentication({
            token: localApiToken,
            ownerId: localOwnerId(getApiIdentity()),
          }),
  });

  // Fetch catalog data in the background so startup is not blocked.
  // getCatalogs() now throws when a cloud has no cached catalog at all (rather
  // than returning a soft error), so surface that loudly instead of leaving an
  // unhandled rejection. Serving continues — the on-demand bootstrap guards
  // return a 503 until a catalog is present, and the hourly monitor keeps
  // retrying.
  refreshCatalogs().catch((error) =>
    log.error('Initial catalog fetch failed at startup', {
      id: 'system',
      error,
    }),
  );

  // Bootstrap the process-local reconciliation schedule before becoming ready,
  // then start the independent periodic services. Startup discovery makes
  // persisted active pipeline work immediately eligible for fact-based recovery.
  await startBackgroundServices();
  startApiOwnershipBackfill();

  // Hourly database backup of the Helm-managed API; refuses to start (and
  // says which operator step is missing) unless the bucket keeps versions.
  // Never holds readiness.
  const databaseBackup = hostedSystemRelease
    ? getDefaultApiDatabaseBackup(hostedSystemRelease.installationId)
    : null;
  if (databaseBackup) {
    // The first backup lands through IAM propagation before the hourly
    // timer starts, since the timer's versioning check fails as early; a
    // new cluster's create waits for it in `api status`.
    const firstBackup = getDefaultFirstBackupCheck(
      hostedSystemRelease!.installationId,
    );
    void startBackups(firstBackup, databaseBackup).catch((error: unknown) =>
      log.warn('API database backup timer did not start', {
        id: 'system',
        error,
      }),
    );
    // Test-only: hand the e2e harness its kubeconfig through the bucket,
    // once the first backup has shown the VM identity reaches it.
    const e2eAccess = getE2eAccessKubeconfigPath();
    const target = getApiBackupConfig();
    if (e2eAccess && target)
      void waitForFile(e2eAccess)
        .then(() => firstBackup?.start())
        .then(() =>
          handOffE2eAccess({
            path: e2eAccess,
            bucket: target.bucket,
            storage: backupStorage(target),
          }),
        )
        .catch((error: unknown) =>
          log.warn('The e2e access kubeconfig was not handed off', {
            id: 'system',
            error,
          }),
        );
  }

  // An upgrade sets this image's chart; after an upgrade from a release
  // before 0.1.68 (values only) it reaches the cluster from here, and any
  // other drift is repaired. Never holds readiness.
  if (hostedSystemRelease) {
    const release = createHostedSystemRelease(hostedSystemRelease);
    void applyOwnChart(release, requestShutdown.signal);
    // Bootstrap applies the API's Traefik once; an upgrade's values reach it
    // here.
    void repairUntilSettled(
      'API ingress',
      () => release.applyApiIngress(),
      () => true,
      requestShutdown.signal,
    );
  }

  // Bind to 0.0.0.0 for container accessibility only after background
  // reconciliation has successfully bootstrapped from durable state.
  const server = app.listen(PORT, '0.0.0.0', () => {
    log.info(`Container server listening on 0.0.0.0:${PORT}`, { id: 'system' });
  });

  const shutdown = createApiShutdown({
    server,
    requests,
    abortRequests: () =>
      requestShutdown.abort(new Error('API server is shutting down')),
    stopBackground: async () => {
      stopApiOwnershipBackfill();
      await stopBackgroundServices();
      // The database closes after this stage; no hourly backup may start then.
      databaseBackup?.stop();
    },
    closeTransports: shutdownSshProcesses,
    closeDatabase: closePersistence,
    flushTelemetry: shutdownTelemetry,
  });
  let shuttingDown = false;
  process.on('SIGTERM', async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('SIGTERM received, shutting down gracefully', { id: 'system' });
    try {
      await shutdown();
      log.info('Server closed', { id: 'system' });
      process.exit(0);
    } catch {
      // The stage failure was logged before the bounded telemetry flush. A
      // nonzero exit keeps the hosted-API checkpoint/VM recovery guard closed.
      process.exit(1);
    }
  });
}

/**
 * Settles once this image's chart and its Helm run are current. Retries while
 * helm-controller's Job is still running (about as long as the release's
 * 600 s timeout). Applying only a differing chart, and only for
 * this image's own release, is what keeps the resulting Helm upgrade (and any
 * Pod it replaces) from looping: the next start finds the chart current.
 */
function applyOwnChart(
  release: SystemReleaseDomain,
  signal: AbortSignal,
): Promise<void> {
  // After `applied`, wait for the Helm run that puts its RBAC in force.
  return repairUntilSettled(
    'API system chart',
    () => release.applyOwnChart(),
    (outcome) => outcome === 'current' || outcome === 'superseded',
    signal,
  );
}

/**
 * Retries a start-up repair every 15 s, a failure counting as `deferred`,
 * until `settled` holds or about 11 minutes pass.
 */
async function repairUntilSettled<Outcome extends string>(
  name: string,
  repair: () => Promise<Outcome>,
  settled: (outcome: Outcome) => boolean,
  signal: AbortSignal,
): Promise<void> {
  for (let attempt = 0; attempt < 45 && !signal.aborted; attempt += 1) {
    const outcome = await repair().catch((error: unknown) => {
      log.warn(`Could not apply the ${name}`, {
        id: 'system',
        error: errorMessage(error),
      });
      return 'deferred' as const;
    });
    if (outcome !== 'deferred') {
      log.info(name, { id: 'system', outcome });
      if (settled(outcome)) return;
    }
    await sleep(15_000, signal).catch(() => undefined);
  }
  log.warn(`${name} not applied; the next start retries`, { id: 'system' });
}

/** A hosted API serves its issuer and the role setup templates trusting it. */
function hostedIssuer(): Pick<
  CreateAppOptions,
  'serviceAccountIssuer' | 'roleSetup'
> {
  const serviceAccountIssuer = inClusterServiceAccountIssuerDocuments();
  return {
    serviceAccountIssuer,
    roleSetup: createRoleSetupDocuments({
      issuer: serviceAccountIssuer,
      subject: API_SERVICE_ACCOUNT_SUBJECT,
      thumbprint: issuerThumbprint,
    }),
  };
}
