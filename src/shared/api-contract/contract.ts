import { apiAccessContract } from './api-access.js';
import { bucketMetadataContract } from './bucket-metadata.js';
import { credentialsContract } from './credentials.js';
import { clustersContract } from './clusters.js';
import { systemReleaseContract } from './system-release.js';
import { databaseContract } from './database.js';
import { workloadManagementContract } from './workload-management.js';
import { workloadAdmissionContract } from './workload-admission.js';
import { notificationsContract } from './notifications.js';
import { quotaContract } from './quota.js';
import { secretsContract } from './secrets.js';
import { spendControlsContract } from './spend-controls.js';
import { serviceUpgradeContract } from './service-upgrade.js';

export const apiContract = {
  spend: spendControlsContract,
  secrets: secretsContract,
  notifications: notificationsContract,
  credentials: credentialsContract,
  clusters: clustersContract,
  systemRelease: systemReleaseContract,
  apiAccess: apiAccessContract,
  database: databaseContract,
  workloads: workloadManagementContract,
  admission: workloadAdmissionContract,
  bucket: bucketMetadataContract,
  quota: quotaContract,
  serviceUpgrade: serviceUpgradeContract,
};
