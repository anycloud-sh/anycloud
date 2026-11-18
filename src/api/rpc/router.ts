import { apiAccessRouter } from './api-access.js';
import { routerImplementation as root } from './base.js';
import { bucketMetadataRouter } from './bucket-metadata.js';
import { credentialsRouter } from './credentials.js';
import { clustersRouter } from './clusters.js';
import { systemReleaseRouter } from './system-release.js';
import { databaseRouter } from './database.js';
import { workloadManagementRouter } from './workload-management.js';
import { workloadAdmissionRouter } from './workload-admission.js';
import { notificationsRouter } from './notifications.js';
import { quotaRouter } from './quota.js';
import { secretsRouter } from './secrets.js';
import { spendControlsRouter } from './spend-controls.js';
import { serviceUpgradeRouter } from './service-upgrade.js';

export const apiRouter = root.router({
  spend: spendControlsRouter,
  secrets: secretsRouter,
  notifications: notificationsRouter,
  credentials: credentialsRouter,
  clusters: clustersRouter,
  systemRelease: systemReleaseRouter,
  apiAccess: apiAccessRouter,
  database: databaseRouter,
  workloads: workloadManagementRouter,
  admission: workloadAdmissionRouter,
  bucket: bucketMetadataRouter,
  quota: quotaRouter,
  serviceUpgrade: serviceUpgradeRouter,
});
