import type { ApiAccessDomain } from '../services/api-access-domain.js';
import type { BucketMetadataDomain } from '../services/bucket-metadata-domain.js';
import type { CredentialsDomain } from '../services/credentials-domain.js';
import type { ClustersDomain } from '../services/clusters-domain.js';
import type { NodePoolsDomain } from '../services/node-pools-domain.js';
import type { DeploymentsDomain } from '../services/deployments-domain.js';
import type { DeploymentWorkloadDomain } from '../services/deployment-workload-domain.js';
import type { DatabaseDomain } from '../services/database-domain.js';
import type { WorkloadManagementDomain } from '../services/workload-management-domain.js';
import type { WorkloadAdmissionDomain } from '../services/workload-admission-domain.js';
import type { NotificationsDomain } from '../services/notifications-domain.js';
import type { QuotaDomain } from '../services/quota-domain.js';
import type { SecretsDomain } from '../services/secrets-domain.js';
import type { SpendControlsDomain } from '../services/spend-controls-domain.js';
import type { ServiceUpgradeDomain } from '../services/service-upgrade-domain.js';
import type { SystemReleaseDomain } from '../services/system-release-domain.js';
import type { AuthenticateApiRequest } from '../services/api-authentication.js';
import type { RequestBudget } from '../services/request-budget.js';
import type { ApiRequestTracker } from '../services/http-shutdown.js';

export interface ApiRpcDomains {
  spendControls: SpendControlsDomain;
  secrets: SecretsDomain;
  notifications: NotificationsDomain;
  credentials: CredentialsDomain;
  clusters: ClustersDomain;
  nodePools: NodePoolsDomain;
  deployments: DeploymentsDomain;
  deploymentWorkload: DeploymentWorkloadDomain;
  apiAccess: ApiAccessDomain;
  database: DatabaseDomain;
  workloadManagement: WorkloadManagementDomain;
  workloadAdmission: WorkloadAdmissionDomain;
  bucketMetadata: BucketMetadataDomain;
  quota: QuotaDomain;
  serviceUpgrade: ServiceUpgradeDomain;
  systemRelease: SystemReleaseDomain;
}

export interface ApiRpcContext {
  requests?: ApiRequestTracker;
  receivedAt?: number;
  shutdownSignal?: AbortSignal;
  releaseIncompleteBody?: () => void;
  operation?: RequestBudget;
  /** Set by `ResponseHeadersPlugin`; merged into the response, errors included. */
  resHeaders?: Headers;
  authorization: string | undefined;
  host?: string;
  githubToken?: string;
  clientVersion: string | undefined;
  authenticate: AuthenticateApiRequest;
  domains: ApiRpcDomains;
}
