import type { SchemaConverter } from '@orpc/openapi';
import * as apiAccess from './api-access-schemas.js';
import * as bucketMetadata from './bucket-metadata-schemas.js';
import * as clusters from './clusters-schemas.js';
import {
  clusterSummarySchema,
  clusterReleaseSummarySchema,
} from './clusters-schemas.js';
import * as systemRelease from './system-release-schemas.js';
import {
  kubernetesStepSchema,
  systemReleaseRolloutSchema,
  systemUpgradeSchema,
} from './system-release-schemas.js';
import * as common from './common-schemas.js';
import * as credentials from './credentials-schemas.js';
import { saveCredentialBodySchema } from './credentials-schemas.js';
import * as database from './database-schemas.js';
import * as workloadAdmission from './workload-admission-schemas.js';
import { workloadAdmissionInputSchema } from './workload-admission-schemas.js';
import * as workloadManagement from './workload-management-schemas.js';
import {
  workloadResubmitBodySchema,
  workloadResubmitResponseSchema,
} from './workload-management-schemas.js';
import * as notifications from './notifications-schemas.js';
import {
  saveNotificationBodySchema,
  testNotificationBodySchema,
} from './notifications-schemas.js';
import * as quota from './quota-schemas.js';
import * as secrets from './secrets-schemas.js';
import { saveSecretBodySchema } from './secrets-schemas.js';
import * as serviceUpgrade from './service-upgrade-schemas.js';
import { serviceUpgradeBodySchema } from './service-upgrade-schemas.js';
import * as spendControls from './spend-controls-schemas.js';
import * as storageTokens from './storage-token-schemas.js';
import { spendCapInputSchema } from './spend-controls-schemas.js';

// These schemas were extracted so public request/response bodies and values
// become named components. Keep their registration explicit; the remaining
// exports are discovered to avoid a parallel inventory of authored models.
const publicBodySchemas = {
  clusterSummarySchema,
  clusterReleaseSummarySchema,
  systemReleaseRolloutSchema,
  systemUpgradeSchema,
  kubernetesStepSchema,
  workloadAdmissionInputSchema,
  workloadResubmitBodySchema,
  workloadResubmitResponseSchema,
  saveNotificationBodySchema,
  testNotificationBodySchema,
  saveCredentialBodySchema,
  saveSecretBodySchema,
  serviceUpgradeBodySchema,
  spendCapInputSchema,
};

const schemaModules = [
  publicBodySchemas,
  apiAccess,
  bucketMetadata,
  clusters,
  common,
  credentials,
  database,
  workloadAdmission,
  workloadManagement,
  notifications,
  quota,
  secrets,
  serviceUpgrade,
  spendControls,
  storageTokens,
  systemRelease,
] as const;

type ConvertibleSchema = NonNullable<Parameters<SchemaConverter['convert']>[0]>;

const excludedSchemas = new Set([
  'aggregateWorkloadCostRequestSchema',
  'bucketObjectRequestSchema',
  'bucketObjectQueryParametersSchema',
  'bucketPathParametersSchema',
  'bucketRequestSchema',
  'channelParamsRequestSchema',
  'workloadListRequestSchema',
  'workloadPathParametersSchema',
  'workloadResubmitRequestSchema',
  'workloadSshAccessRequestSchema',
  'workloadStatusRequestSchema',
  'workloadTerminateRequestSchema',
  'exactWorkloadCostRequestSchema',
  'listBucketObjectsRequestSchema',
  'listBucketsRequestSchema',
  'mintStorageTokensRequestSchema',
  'noContentSchema',
  'noInputSchema',
  'quotaStatusQuerySchema',
  'saveCredentialRequestSchema',
  'saveNotificationRequestSchema',
  'saveSecretRequestSchema',
  'serviceUpgradeRequestSchema',
  'setBudgetRequestSchema',
  'setThrottleRequestSchema',
  'testNotificationRequestSchema',
  'unsetBudgetRequestSchema',
  'unsetThrottleRequestSchema',
  'updateCredentialRequestSchema',
]);

function componentName(exportName: string): string {
  const withoutSuffix = exportName.replace(/Schema$/u, '');
  return `${withoutSuffix[0]?.toUpperCase()}${withoutSuffix.slice(1)}`;
}

interface ApiOpenApiSchemaRegistry {
  commonSchemas: Record<
    string,
    { schema: ConvertibleSchema; strategy: 'input' }
  >;
  names: Map<unknown, string>;
}

/**
 * Give every generated public bounded-JSON model one stable OpenAPI identity.
 * Transport-only wrapper objects stay inline while their body schemas use
 * components. Values remain the authored Zod objects; this registry adds names
 * only.
 */
function createRegistry(): ApiOpenApiSchemaRegistry {
  const commonSchemas: ApiOpenApiSchemaRegistry['commonSchemas'] = {};
  const names = new Map<unknown, string>();

  for (const schemaExports of schemaModules) {
    for (const [exportName, schema] of Object.entries(schemaExports)) {
      if (!exportName.endsWith('Schema') || excludedSchemas.has(exportName)) {
        continue;
      }
      if (names.has(schema)) continue;

      const name = componentName(exportName);
      if (commonSchemas[name]) {
        throw new Error(`Duplicate OpenAPI schema component name: ${name}`);
      }
      names.set(schema, name);
      commonSchemas[name] = {
        schema: schema as ConvertibleSchema,
        strategy: 'input',
      };
    }
  }

  return { commonSchemas, names };
}

const registry = createRegistry();

export function apiOpenApiSchemas(): Record<
  string,
  { schema: ConvertibleSchema; strategy: 'input' }
> {
  return registry.commonSchemas;
}

export function apiOpenApiSchemaName(schema: unknown): string | undefined {
  return registry.names.get(schema);
}
