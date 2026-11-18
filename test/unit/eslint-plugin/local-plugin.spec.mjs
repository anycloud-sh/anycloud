import { createRequire } from 'node:module';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { cruise } from 'dependency-cruiser';

import { Linter, RuleTester } from 'eslint';
import { describe, expect, it } from 'vitest';

import localPlugin from '../../../eslint-plugin-local/index.mjs';

const require = createRequire(import.meta.url);
const { FlatESLint } = require('eslint/use-at-your-own-risk');
const depcruiseConfig = require('../../../.dependency-cruiser.cjs');

RuleTester.describe = describe;
RuleTester.it = (name, check) => it(name, () => expect(check).not.toThrow());
RuleTester.itOnly = () => {
  throw new Error('Focused lint-rule tests are forbidden');
};

const ruleTester = new RuleTester({
  parser: require.resolve('@typescript-eslint/parser'),
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
});

ruleTester.run(
  'exact-vm-compute-ownership',
  localPlugin.rules['exact-vm-compute-ownership'],
  {
    valid: [
      {
        filename: 'src/api/services/monitor.ts',
        code: 'await vm.observeReleaseOnce(); await vm.preemption.restart();',
      },
      {
        filename: 'src/api/services/host-runtime/termination.ts',
        code: 'const vm = bindVmCompute(compute, identity); await terminateVmComputes([vm]);',
      },
      {
        filename: 'src/api/services/node-pool-controller.ts',
        code: 'const vm = bindVmCompute(compute, identity); await terminateVmComputes([vm]);',
      },
      {
        filename: 'src/api/services/cluster-installer-runtime.ts',
        code: 'const vm = bindVmCompute(compute, identity); await terminateVmComputes([vm]); await vm.confirmRelease();',
      },
      ...[
        'vm-compute',
        ...['cloud', 'aws', 'azure', 'gcp', 'lambda', 'local'].map(
          (name) => `gateways/${name}`,
        ),
      ].map((owner) => ({
        filename: `src/api/services/${owner}.ts`,
        code: 'await compute.terminateVMs(ids); await compute.observeVMReleaseOnce(id); await confirmVMRelease(compute, id); await compute.verifyVMPreemption(id); await compute.startVM(id);',
      })),
    ],
    invalid: [
      ...[
        'terminateVMs',
        'observeVMReleaseOnce',
        'confirmVMRelease',
        'verifyVMPreemption',
        'startVM',
      ].flatMap((name) =>
        [
          `const invoke = compute.${name};`,
          `await compute['${name}'](id);`,
          `await compute[\`${name}\`](id);`,
          `const { ${name}: invoke } = compute;`,
          `const { '${name}': invoke } = compute;`,
          `const invoke = Reflect.get(compute, '${name}');`,
          `import { ${name} as invoke } from './gateways/cloud.js';`,
        ].map((code) => ({
          filename: 'src/api/services/monitor.ts',
          code,
          errors: [{ messageId: 'lifecycle' }],
        })),
      ),
      ...[
        'src/api/services/host-runtime/termination.ts',
        'src/api/services/node-pool-controller.ts',
        'src/api/services/cluster-installer-runtime.ts',
        'src/api/services/vm-runtime-storage.ts',
        'src/api/services/nested/vm-compute.ts',
        'src/api/services/gateways/other.ts',
        'src/cli/commands/cleanup.ts',
        'src/shared/compute.ts',
      ].map((filename) => ({
        filename,
        code: 'await compute.terminateVMs(ids);',
        errors: [{ messageId: 'lifecycle' }],
      })),
      ...[
        'src/api/services/monitor.ts',
        'src/api/services/gateways/gcp.ts',
        'src/api/services/conduct.ts',
        'src/api/services/nested/host-runtime/termination.ts',
        'src/api/services/nested/node-pool-controller.ts',
        'src/api/services/node-pool-reconciler.ts',
      ].map((filename) => ({
        filename,
        code: 'import { bindVmCompute as bind } from "./vm-compute.js";',
        errors: [{ messageId: 'binding' }],
      })),
    ],
  },
);

ruleTester.run(
  '0036 container-spec-write-ownership',
  localPlugin.rules['container-spec-write-ownership'],
  {
    valid: [
      {
        filename: 'src/api/services/container-spec.ts',
        code: 'export async function insertContainerSpec(db) { return db.transaction(tx => tx.query(`INSERT INTO container_specs (id) VALUES (?)`)); }',
      },
      {
        filename: 'src/api/services/deployment-store.ts',
        code: 'export class DeploymentStore { update() { return db.transaction(tx => tx.query("UPDATE container_specs SET image = ?")); } }',
      },
      {
        code: 'db.query("SELECT * FROM container_specs")',
      },
      ...[
        'db.query(`SELECT * FROM ${table}`)',
        'db.query(sql); db.exec(prepared.sql);',
        'db.query(`UPDATE workloads SET ${assignments} WHERE ${predicate}`)',
        'db.query("UPDATE " + "workloads SET state = ? WHERE " + predicate)',
        'db.query("UPDATE workloads SET session = \'UPDATE container_specs SET image = ?\'")',
        'db.query("UPDATE workloads SET session = \'--\'; SELECT 1")',
        'db.query("SELECT \'UPDATE container_specs\'")',
        'db.query("/* UPDATE container_specs */ UPDATE workloads SET state = ?")',
        'log.error(`Failed to update ${name}`)',
        'throw new Error("Cannot update " + entity)',
        'log.error(`Unable to DELETE FROM ${name}`)',
        'log.error(`; Unable to DELETE FROM ${name}`)',
        'log.error(`Unable; DELETE FROM ${name}`)',
        'log.error(`Failed; UPDATE ${name} after retry`)',
      ].map((code) => ({ code })),
      {
        filename: 'src/api/services/deployment-store.ts',
        code: 'export class DeploymentStore { update() { db.query(`UPDATE ${"container_" + "specs"} SET ${assignments} WHERE ${predicate}`); } }',
      },
    ],
    invalid: [
      ...[
        'INSERT INTO container_specs (id) VALUES (?)',
        'INSERT OR REPLACE INTO container_specs (id) VALUES (?)',
        'UPDATE OR REPLACE main.container_specs SET id = ?',
        'DELETE FROM "container_specs"',
        "DELETE FROM 'container_specs'",
        'REPLACE INTO [container_specs] (id) VALUES (?)',
        'UPDATE /* comment */ container_specs SET image = ?',
        'INSERT /* comment */ INTO container_specs (image) VALUES (?)',
        'DELETE /* comment */ FROM main /* comment */ .container_specs',
        'UPDATE -- comment\n container_specs SET image = ?',
        'UPDATE "main"."container_specs" SET image = ?',
        'UPDATE other_schema.container_specs SET image = ?',
        "UPDATE workloads SET session = '--'; DELETE FROM container_specs",
        'CREATE TABLE container_specs (id TEXT)',
        'CREATE TABLE IF NOT EXISTS main."container_specs" (id TEXT)',
        'CREATE TEMPORARY TABLE "container_specs" (id TEXT)',
        'CREATE VIRTUAL TABLE [container_specs] USING fts5(image)',
        'ALTER TABLE main.container_specs ADD COLUMN revision INTEGER',
        "DROP TABLE IF EXISTS 'container_specs'",
      ].map((sql) => ({
        code: `db.query(${JSON.stringify(sql)})`,
        errors: [{ messageId: 'owner' }],
      })),
      ...[
        'db.query(`UPDATE ${"container_specs"} SET image = ?`)',
        'db.query(`UPDATE ${"container_" + "specs"} SET image = ?`)',
        'db.query("UP" + "DATE container_" + "specs SET image = ?")',
        'db.query(`${"UPDATE"} ${`container_${"specs"}`} SET image = ?`)',
        'db.query(("UPDATE " as string) + ("container_specs" satisfies string) + " SET image = ?")',
      ].map((code) => ({ code, errors: [{ messageId: 'owner' }] })),
      ...[
        'db.query(`UPDATE ${table} SET image = ?`)',
        'const table = "container_specs"; db.query(`UPDATE ${table} SET image = ?`)',
        'db.query("UPDATE " + table + " SET image = ?")',
        'db.query("UP" + "DATE " + table + " SET image = ?")',
        'db.query(`UPDATE container_${suffix} SET image = ?`)',
        'db.query(`UPDATE ${schema}.container_specs SET image = ?`)',
        'db.query(`UPDATE main.${table} SET image = ?`)',
        'db.query(`UPDATE "${schema}"."container_specs" SET image = ?`)',
        'db.query(`UPDATE "${table}" SET image = ?`)',
        'db.query(`UPDATE "${tableAndQuote} SET image = ?`)',
        'db.query(`UPDATE [${tableAndBracket} SET image = ?`)',
        'db.query(`DELETE FROM [${table}]`)',
        'db.query("INSERT INTO \'" + table + "\' (image) VALUES (?)")',
        'db.query(`INSERT OR REPLACE INTO ${table} (image) VALUES (?)`)',
        'db.query(`UPDATE OR IGNORE ${table} SET image = ?`)',
        'db.query(`UPDATE OR ${mode} container_specs SET image = ?`)',
        'db.query(`INSERT OR ${mode} INTO container_specs (image) VALUES (?)`)',
        'db.query(`REPLACE INTO ${table} (image) VALUES (?)`)',
        'db.query(`DELETE FROM ${table}`)',
        'db.query(`UPDATE /* ${comment} */ container_specs SET image = ?`)',
        'db.query(`UPDATE /* ${comment} */ ${table} SET image = ?`)',
        'db.query(`UPDATE /* ${comment} */ workloads SET state = ?`)',
        'db.query(`UPDATE /* ${endComment} container_specs SET image = ?`)',
        'db.query(`INSERT /* ${endComment} INTO container_specs (image) VALUES (?)`)',
        'db.query(`UPDATE main /* ${endComment} .container_specs SET image = ?`)',
        'db.query(`INSERT /* ${comment} */ INTO container_specs (image) VALUES (?)`)',
        'db.query(`DELETE /* ${comment} */ FROM container_specs`)',
        'db.query(`UPDATE main /* ${comment} */ .container_specs SET image = ?`)',
        'db.query(`UPDATE -- ${comment}\n ${table} SET image = ?`)',
        'db.query(`UPDATE ${(table as string)!} SET image = ?`)',
        'db.query(("UPDATE " + table + " SET image = ?") satisfies string)',
        'db.query(`WITH selected AS (SELECT id FROM workloads) UPDATE ${table} SET image = ?`)',
        'db.exec(`SELECT 1; DELETE FROM ${table}`)',
        'db.exec(`; UPDATE ${table} SET image = ?`)',
        'db.exec(`; /* preface */ ; DELETE FROM ${table}`)',
        'db.exec(`CREATE TABLE ${table} (id TEXT)`)',
        'db.exec(`ALTER TABLE ${table} ADD COLUMN revision INTEGER`)',
        'db.exec(`DROP TABLE IF EXISTS ${schema}.${table}`)',
        'db.exec(`SAVEPOINT spec_write; UPDATE ${table} SET image = ?`)',
        'db.exec(`COMMIT; DELETE FROM ${table}`)',
        'db.exec(`END; INSERT INTO ${table} (image) VALUES (?)`)',
        'db.exec(`ROLLBACK; REPLACE INTO ${table} (image) VALUES (?)`)',
        'db.exec(`RELEASE spec_write; UPDATE ${table} SET image = ?`)',
      ].map((code) => ({
        code,
        errors: [{ messageId: 'dynamicTarget' }],
      })),
      {
        filename: 'src/api/services/deployment-store.ts',
        code: 'export class DeploymentStore { update() { db.query(`UPDATE ${table} SET image = ?`); } }',
        errors: [{ messageId: 'dynamicTarget' }],
      },
      {
        filename: 'src/api/services/repositories/workload-lifecycle.ts',
        code: 'export class WorkloadLifecycleStore { repair() { db.query(`UPDATE container_specs SET image = ?`); } }',
        errors: [{ messageId: 'owner' }],
      },
      {
        filename: 'src/api/services/deployment-store-copy.ts',
        code: 'export class DeploymentStore { update() { db.query(`UPDATE container_specs SET image = ?`); } }',
        errors: [{ messageId: 'owner' }],
      },
      {
        filename: 'src/api/services/deployment-store.ts',
        code: 'export class OtherStore { update() { db.query(`DELETE FROM container_specs`); } }',
        errors: [{ messageId: 'owner' }],
      },
      {
        filename: 'src/api/services/deployment-store.ts',
        code: 'export function update() { db.query(`DELETE FROM container_specs`); }',
        errors: [{ messageId: 'owner' }],
      },
      {
        filename: 'src/api/services/container-spec.ts',
        code: 'export class ContainerSpecs { insertContainerSpec() { db.query(`INSERT INTO container_specs (id) VALUES (?)`); } }',
        errors: [{ messageId: 'owner' }],
      },
      {
        filename: 'src/api/services/container-spec.ts',
        code: 'function insertContainerSpec() { db.query(`INSERT INTO container_specs (id) VALUES (?)`); }',
        errors: [{ messageId: 'owner' }],
      },
      {
        filename: 'src/api/services/container-spec.ts',
        code: 'function wrapper() { function insertContainerSpec() { db.query(`INSERT INTO container_specs (id) VALUES (?)`); } }',
        errors: [{ messageId: 'owner' }],
      },
      {
        filename: 'src/api/services/deployment-store.ts',
        code: 'export class DeploymentStore { update() { const write = () => db.query(`DELETE FROM container_specs`); return write(); } }',
        errors: [{ messageId: 'owner' }],
      },
      {
        filename: 'src/api/services/deployment-store.ts',
        code: 'export class DeploymentStore { update() { const write = function writeSpec() { db.query(`DELETE FROM container_specs`); }; return write(); } }',
        errors: [{ messageId: 'owner' }],
      },
      {
        filename: 'src/api/services/deployment-store.ts',
        code: 'export function wrapper() { class DeploymentStore { update() { db.query(`DELETE FROM container_specs`); } } return DeploymentStore; }',
        errors: [{ messageId: 'owner' }],
      },
      {
        filename: 'src/api/services/deployment-store.ts',
        code: 'class DeploymentStore { update() { db.query(`DELETE FROM container_specs`); } }',
        errors: [{ messageId: 'owner' }],
      },
      {
        filename: 'src/api/services/deployment-store.ts',
        code: 'export class DeploymentStore { [update]() { db.query(`DELETE FROM container_specs`); } }',
        errors: [{ messageId: 'owner' }],
      },
      {
        filename: 'src/api/services/deployment-store.ts',
        code: 'export class DeploymentStore { static update() { db.query(`DELETE FROM container_specs`); } }',
        errors: [{ messageId: 'owner' }],
      },
      {
        filename: 'src/api/services/deployment-store.ts',
        code: 'export class DeploymentStore { get update() { db.query(`DELETE FROM container_specs`); return 1; } }',
        errors: [{ messageId: 'owner' }],
      },
      {
        filename: 'src/api/services/repositories/deployment-executions.ts',
        code: 'export function createTargetedWorkload() { db.query(`INSERT INTO container_specs (id) VALUES (?)`); }',
        errors: [{ messageId: 'owner' }],
      },
    ],
  },
);

describe('workload-event metadata ownership ESLint configuration', () => {
  const eslint = new FlatESLint({ cwd: process.cwd() });
  const ruleId = 'local/workload-event-metadata-ownership';
  const rawWrite =
    "db.query('INSERT INTO workload_events (metadata) VALUES (?)', [raw]);";

  it.each([
    'src/api/services/repositories/workload-events.ts',
    'src/api/services/zz-new-writer.mts',
  ])('checks every API writer, including %s', async (filePath) => {
    const config = await eslint.calculateConfigForFile(filePath);
    expect(config?.rules?.[ruleId]?.[0]).toBe(2);
    const [result] = await eslint.lintText(rawWrite, { filePath });
    expect(result.fatalErrorCount).toBe(0);
    expect(
      result.messages.filter((message) => message.ruleId === ruleId),
    ).toHaveLength(1);
  });

  it('rejects an unjustified inline disable of the rule', async () => {
    const [result] = await eslint.lintText(
      `// eslint-disable-next-line ${ruleId}\n${rawWrite}`,
      { filePath: 'src/api/services/repositories/workload-events.ts' },
    );
    expect(result.messages.map((message) => message.ruleId)).toContain(
      'local/protected-rule-disable-policy',
    );
  });

  it('leaves code outside the API unconfigured', async () => {
    const config = await eslint.calculateConfigForFile('src/cli/zz-writer.ts');
    expect(config?.rules?.[ruleId]).toBeUndefined();
  });
});

describe('container-spec write ownership ESLint configuration', () => {
  const eslint = new FlatESLint({ cwd: process.cwd() });

  it.each(['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'])(
    'enforces ownership for .%s without widening exact owner exemptions',
    async (extension) => {
      const filePath = `src/api/services/container-spec.${extension}`;
      const ruleId = 'local/container-spec-write-ownership';
      const config = await eslint.calculateConfigForFile(filePath);
      expect(config?.rules?.[ruleId]?.[0]).toBe(2);

      const [unauthorized] = await eslint.lintText(
        'export function repair() { db.query("UPDATE container_specs SET image = ?"); }',
        { filePath },
      );
      expect(unauthorized.fatalErrorCount).toBe(0);
      expect(
        unauthorized.messages.filter((message) => message.ruleId === ruleId),
      ).toHaveLength(1);

      const [owner] = await eslint.lintText(
        'export function insertContainerSpec() { db.query("INSERT INTO container_specs (image) VALUES (?)"); }',
        { filePath },
      );
      expect(owner.fatalErrorCount).toBe(0);
      expect(
        owner.messages.filter((message) => message.ruleId === ruleId),
      ).toHaveLength(extension === 'ts' ? 0 : 1);
    },
  );
});

const unapprovedProviderRuntimeImports = [
  {
    source: '@aws-sdk/client-dynamodb',
    name: 'DynamoDBClient',
  },
  {
    source: '@azure/arm-future',
    name: 'FutureManagementClient',
  },
  {
    source: '@google-cloud/future',
    name: 'FutureClient',
  },
];

const providerRuntimeImportCases = unapprovedProviderRuntimeImports.map(
  ({ source, name }) => ({
    code: `import { ${name} } from '${source}'; use(${name});`,
    errors: [{ messageId: 'runtimeImport' }],
  }),
);

ruleTester.run(
  'explicit-api-provider-credentials',
  localPlugin.rules['explicit-api-provider-credentials'],
  {
    valid: [
      {
        filename: 'src/api/services/provider-clients/aws.ts',
        code: "import { S3Client } from '@aws-sdk/client-s3'; new S3Client({ ...options, credentials: stored });",
      },
      {
        filename: 'src/api/services/provider-clients/cloudflare.ts',
        code: "import { S3Client } from '@aws-sdk/client-s3'; new S3Client({ endpoint, credentials: stored });",
      },
      {
        filename: 'src/api/services/provider-clients/gcp.ts',
        code: "import { Storage } from '@google-cloud/storage'; new Storage({ ...options, credentials: stored });",
      },
      {
        filename: 'src/api/services/provider-clients/azure.ts',
        code: "import { ClientSecretCredential } from '@azure/identity'; new ClientSecretCredential(tenant, client, secret);",
      },
      {
        filename: 'src/api/services/provider-clients/gcp.ts',
        code: "import { DownscopedClient, JWT } from 'google-auth-library'; new DownscopedClient(new JWT({ email, key }), boundary);",
      },
      {
        filename: 'src/api/services/provider-clients/gcp.ts',
        code: "import { IdentityPoolClient } from 'google-auth-library'; new IdentityPoolClient({ subject_token_supplier });",
      },
      {
        filename: 'src/api/services/provider-clients/azure.ts',
        code: "import { ClientAssertionCredential } from '@azure/identity'; new ClientAssertionCredential(tenant, client, assertion);",
      },
      {
        filename: 'src/api/services/provider-clients/azure.ts',
        code: "import { AuthenticationRequiredError } from '@azure/identity'; error instanceof AuthenticationRequiredError;",
      },
      {
        filename: 'src/api/services/provider-clients/aws.ts',
        code: "import { AssumeRoleWithWebIdentityCommand } from '@aws-sdk/client-sts'; new AssumeRoleWithWebIdentityCommand(input);",
      },
      "import { ListBucketsCommand } from '@aws-sdk/client-s3'; new ListBucketsCommand({});",
      "import { ListTablesCommand as Command } from '@aws-sdk/client-dynamodb'; new Command({});",
      "import { VolumeType } from '@aws-sdk/client-ec2'; use(VolumeType.gp3);",
      "import { waitUntilBucketExists } from '@aws-sdk/client-s3'; use(waitUntilBucketExists);",
      "import { Upload } from '@aws-sdk/lib-storage'; use(Upload);",
      "import { createWaiter, WaiterState } from '@aws-sdk/util-waiter'; use(createWaiter, WaiterState);",
      "import type { S3Client } from '@aws-sdk/client-s3'; let client: S3Client;",
      "import type { v1 } from '@google-cloud/compute'; let operation: v1.IOperation;",
      "import type * as storage from '@google-cloud/storage'; let client: storage.Storage;",
    ],
    invalid: [
      {
        code: "import { S3Client } from '@aws-sdk/client-s3'; new S3Client();",
        errors: [{ messageId: 'factoryOnly' }],
      },
      {
        code: "import { S3 } from '@aws-sdk/client-s3'; new S3({ region });",
        errors: [{ messageId: 'factoryOnly' }],
      },
      {
        code: "import { InstancesClient } from '@google-cloud/compute'; new InstancesClient({ projectId });",
        errors: [{ messageId: 'factoryOnly' }],
      },
      {
        code: "import * as storage from '@google-cloud/storage'; new storage.Storage({});",
        errors: [{ messageId: 'namedImports' }],
      },
      {
        code: "import { BigQuery } from '@google-cloud/bigquery'; new BigQuery({ projectId });",
        errors: [{ messageId: 'factoryOnly' }],
      },
      {
        code: "import { ExperimentalClient } from '@aws-sdk/client-s3'; new ExperimentalClient({});",
        errors: [{ messageId: 'runtimeImport' }],
      },
      ...providerRuntimeImportCases,
      {
        code: "use(ImportedClient); import { FutureClient as ImportedClient } from '@google-cloud/future';",
        errors: [{ messageId: 'runtimeImport' }],
      },
      {
        code: "import { AttributeValue } from '@aws-sdk/client-dynamodb'; use(AttributeValue);",
        errors: [{ messageId: 'runtimeImport' }],
      },
      {
        code: "import { STSClient } from '@aws-sdk/nested-clients/sts'; use(STSClient);",
        errors: [{ messageId: 'runtimeImport' }],
      },
      {
        code: "import { S3Client } from '@aws-sdk/client-s3'; new S3Client({ credentials: stored, ...later });",
        errors: [{ messageId: 'factoryOnly' }],
      },
      {
        code: "import { v1 } from '@google-cloud/compute'; new v1.InstancesClient({});",
        errors: [{ messageId: 'runtimeImport' }],
      },
      {
        code: "import '@google-cloud/storage';",
        errors: [{ messageId: 'sideEffectImport' }],
      },
      {
        code: "import { defaultProvider } from '@aws-sdk/credential-provider-node';",
        errors: [{ messageId: 'defaultChain' }],
      },
      {
        code: "import { fromInstanceMetadata } from '@smithy/credential-provider-imds';",
        errors: [{ messageId: 'defaultChain' }],
      },
      {
        code: "import { GoogleAuth } from 'google-auth-library';",
        errors: [{ messageId: 'defaultChain' }],
      },
      {
        code: "import { JWT } from 'google-auth-library';",
        errors: [{ messageId: 'defaultChain' }],
      },
      {
        filename: 'src/api/services/provider-clients/gcp.ts',
        code: "import { GoogleAuth, JWT } from 'google-auth-library';",
        errors: [{ messageId: 'defaultChain' }],
      },
      {
        code: "import { instance } from 'gcp-metadata';",
        errors: [{ messageId: 'defaultChain' }],
      },
      {
        code: "import { instance } from 'gcp-metadata/build/src/index.js';",
        errors: [{ messageId: 'defaultChain' }],
      },
      {
        code: "import { GoogleAuth } from 'google-gax';",
        errors: [{ messageId: 'defaultChain' }],
      },
      {
        code: "import { DefaultAzureCredential } from '@azure/identity';",
        errors: [{ messageId: 'defaultChain' }],
      },
      {
        code: "import { ClientSecretCredential } from '@azure/identity';",
        errors: [{ messageId: 'defaultChain' }],
      },
      {
        code: "import { ClientAssertionCredential } from '@azure/identity';",
        errors: [{ messageId: 'defaultChain' }],
      },
      {
        code: "import { AssumeRoleWithWebIdentityCommand } from '@aws-sdk/client-sts';",
        errors: [{ messageId: 'factoryOnly' }],
      },
      {
        filename: 'src/api/services/provider-clients/gcp.ts',
        code: "import { v1 } from '@google-cloud/compute';",
        errors: [{ messageId: 'factoryAllowlist' }],
      },
      {
        filename: 'src/api/services/provider-clients/aws.ts',
        code: "import { ListBucketsCommand } from '@aws-sdk/client-s3';",
        errors: [{ messageId: 'factoryAllowlist' }],
      },
      {
        filename: 'src/api/services/provider-clients/cloudflare.ts',
        code: "import { EC2Client } from '@aws-sdk/client-ec2';",
        errors: [{ messageId: 'factoryAllowlist' }],
      },
      {
        filename: 'src/api/services/provider-clients/aws.ts',
        code: "import { DynamoDBClient } from '@aws-sdk/client-dynamodb';",
        errors: [{ messageId: 'factoryAllowlist' }],
      },
      {
        filename: 'src/api/services/provider-clients/azure.ts',
        code: "import { DefaultAzureCredential } from '@azure/identity';",
        errors: [{ messageId: 'defaultChain' }],
      },
    ],
  },
);

ruleTester.run(
  'workload-event-metadata-ownership',
  localPlugin.rules['workload-event-metadata-ownership'],
  {
    valid: [
      'db.query(`INSERT INTO workload_events (metadata) VALUES (?)`, [eventMetadataColumn(m)]);',
      'db.query(`UPDATE workload_events SET metadata = json(?)`, [eventMetadataColumn(m)]);',
      // Binds no value into metadata, so there is nothing to redact.
      "db.query(`UPDATE workload_events SET metadata = json_set(metadata, '$.inPlaceRestartSucceeded', 1)`, [id]);",
      // A different table is none of this rule's business.
      'db.query(`INSERT INTO workloads (metadata) VALUES (?)`, [JSON.stringify(m)]);',
    ],
    invalid: [
      {
        code: 'db.query(`INSERT INTO workload_events (metadata) VALUES (?)`, [JSON.stringify(m)]);',
        errors: [{ messageId: 'unowned' }],
      },
      {
        code: 'db.query(`UPDATE workload_events SET metadata = json(?)`, [JSON.stringify(redactValue(m))]);',
        errors: [{ messageId: 'unowned' }],
      },
    ],
  },
);

ruleTester.run(
  'no-hand-rolled-error-message',
  localPlugin.rules['no-hand-rolled-error-message'],
  {
    valid: [
      'const message = errorMessage(error);',
      'log.warn("failed", { error });',
      // Narrowing to branch on an Error is not the same as flattening one.
      'if (error instanceof Error) throw error;',
      'const name = error instanceof Error ? error.name : "unknown";',
      // Different variable on each side: not this pattern, and rewriting it
      // would change which value is read.
      'const m = outer instanceof Error ? inner.message : String(inner);',
    ],
    invalid: [
      {
        code: 'const m = error instanceof Error ? error.message : String(error);',
        errors: [{ messageId: 'handRolled' }],
      },
      {
        // The fallback does not matter; flattening the Error is the problem.
        code: "const m = err instanceof Error ? err.message : 'Unknown error';",
        errors: [{ messageId: 'handRolled' }],
      },
      {
        code: 'log.warn("x", { error: e instanceof Error ? e.message : String(e) });',
        errors: [{ messageId: 'logMetadata' }],
      },
      {
        // An injected logger is still a logger.
        code: 'deps.logWarn("x", { error: e instanceof Error ? e.message : String(e) });',
        errors: [{ messageId: 'logMetadata' }],
      },
      {
        // A JSON response body is not. Advising "pass the error itself" here
        // is how `{"error":{}}` reached a client once already: JSON.stringify
        // reaches none of an Error's own fields.
        code: 'sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });',
        errors: [{ messageId: 'handRolled' }],
      },
      {
        // Nor is a string-typed field on a real type.
        code: 'result.errors.push({ resourceId: id, error: e instanceof Error ? e.message : String(e) });',
        errors: [{ messageId: 'handRolled' }],
      },
    ],
  },
);

ruleTester.run(
  'no-raw-error-in-persisted-metadata',
  localPlugin.rules['no-raw-error-in-persisted-metadata'],
  {
    valid: [
      // Asserting a callback received an error is correct and common; the rule
      // must not fire on it or it will be disabled wholesale.
      'expect(onError).toHaveBeenCalledWith(error);',
      'log.error("failed", { error });',
      'store.updateState(id, state, { metadata: { error: serializeError(err) } });',
      "store.updateState(id, state, { metadata: { reason: 'exhausted' } });",
      "expect(spy).toHaveBeenCalledWith({ metadata: { error: { message: 'x' } } });",
      // An identifier named `error` very often holds an already-serialized
      // value; resolving the binding is what keeps this rule usable.
      'const error = errorForDiagnosticMetadata(raw); store.publish(id, s, p, { metadata: { error } });',
    ],
    invalid: [
      {
        code: "expect(spy).toHaveBeenCalledWith({ metadata: { error: new Error('boom') } });",
        errors: [{ messageId: 'rawError' }],
      },
      {
        code: "expect(spy).toHaveBeenCalledWith({ metadata: { error: new ContainerExitError('x', s) } });",
        errors: [{ messageId: 'rawError' }],
      },
      {
        code: "const error = new Error('boom'); store.updateState(id, s, { metadata: { error } });",
        errors: [{ messageId: 'rawError' }],
      },
    ],
  },
);

ruleTester.run(
  'no-skipped-or-focused-tests',
  localPlugin.rules['no-skipped-or-focused-tests'],
  {
    valid: [
      'test("works", () => {});',
      'describe("suite", () => {});',
      'queue.skip;',
      'test("checks", () => expect(result).toBe(true));',
      'test("rejects", () => { if (!credentials) throw new Error("credentials required"); expect(result).toBe(true); });',
      'test("helper", () => { const helper = () => { if (ready) return; work(); }; helper(); expect(result).toBe(true); });',
      'test("promise", () => { return expect(operation()).resolves.toBe(true); });',
      'test("outcome", () => { if (invalid) { expect(result).toEqual(expectedError); return; } expect(result).toEqual(expectedSuccess); });',
    ],
    invalid: [
      {
        code: 'test.skip("later", () => {});',
        errors: [{ messageId: 'skip' }],
      },
      {
        code: 'describe.skipIf(process.env.CI)("conditional", () => {});',
        errors: [{ messageId: 'skipIf' }],
      },
      {
        code: 'it.only("focused", () => {});',
        errors: [{ messageId: 'only' }],
      },
      {
        code: 'const skip = test.skip;',
        errors: [{ messageId: 'skip' }],
      },
      {
        code: 'test.concurrent.skip("later", () => {});',
        errors: [{ messageId: 'skip' }],
      },
      {
        code: 'describe.sequential.only("focused", () => {});',
        errors: [{ messageId: 'only' }],
      },
      {
        code: 'test.for(cases).skip("later", () => {});',
        errors: [{ messageId: 'skip' }],
      },
      // A renamed Vitest binding (import { test as check }) must not evade
      // the rule; the callee-name check deliberately covers every .only().
      {
        code: 'check.only("focused", () => {});',
        errors: [{ messageId: 'only' }],
      },
      ...[
        [
          'if (credentials) test("conditional", () => expect(1).toBe(1));',
          'conditionalDefinition',
        ],
        [
          'credentials && describe("conditional", () => {});',
          'conditionalDefinition',
        ],
        [
          'test("conditional", { skip: !credentials }, () => expect(1).toBe(1));',
          'skip',
        ],
        [
          'test("conditional", { "skip": !credentials }, () => expect(1).toBe(1));',
          'skip',
        ],
        [
          'test("conditional", { ["skip"]: !credentials }, () => expect(1).toBe(1));',
          'skip',
        ],
        ['test.todo("unfinished");', 'todo'],
        ['test("unfinished");', 'todo'],
        ['test.runIf(credentials)("conditional", () => {});', 'runIf'],
        ['describe.runIf(credentials)("conditional", () => {});', 'runIf'],
        ['xit("disabled", () => {});', 'skip'],
        [
          'import { xtest as later } from "vitest"; later("disabled", () => {});',
          'skip',
        ],
        ['test("skipped at runtime", ({ skip }) => { skip(); });', 'skip'],
        ['const { skip: later } = test; later("disabled", () => {});', 'skip'],
        [
          'const { "skip": later } = test; later("disabled", () => {});',
          'skip',
        ],
        ['const later = test["todo"];', 'todo'],
      ].map(([code, messageId]) => ({ code, errors: [{ messageId }] })),
    ],
  },
);

ruleTester.run(
  'no-barrel-reexports',
  localPlugin.rules['no-barrel-reexports'],
  {
    valid: [
      'export const value = 1;',
      'const value = 1; export { value };',
      'type Value = string; export type { Value };',
      "import { value } from './owner.js'; export const derived = value;",
    ],
    invalid: [
      {
        code: "export * from './owner.js';",
        errors: [{ messageId: 'reexport' }],
      },
      {
        code: "export { value } from './owner.js';",
        errors: [{ messageId: 'reexport' }],
      },
      {
        code: "export type { Value } from './owner.js';",
        errors: [{ messageId: 'reexport' }],
      },
      {
        code: "import { value } from './owner.js'; export { value };",
        errors: [{ messageId: 'reexport' }],
      },
      {
        code: "import type { Value } from './owner.js'; export type { Value };",
        errors: [{ messageId: 'reexport' }],
      },
      {
        code: "import value from './owner.js'; export default value;",
        errors: [{ messageId: 'reexport' }],
      },
    ],
  },
);

ruleTester.run(
  'no-unsafe-type-assertions',
  localPlugin.rules['no-unsafe-type-assertions'],
  {
    valid: [
      {
        code: 'const state = WorkloadState.Ready;',
        filename: 'file.ts',
      },
      {
        code: 'const fixture: Fixture = { id: "fixture" };',
        filename: 'file.ts',
      },
      {
        code: 'const fixture = { id: "fixture" } as const;',
        filename: 'file.ts',
      },
    ],
    invalid: [
      {
        code: 'const state = "ready" as WorkloadState;',
        errors: [{ messageId: 'workloadState' }],
        filename: 'file.ts',
      },
      {
        code: 'const mocked = dependency as Mock;',
        errors: [{ messageId: 'mock' }],
        filename: 'file.ts',
      },
      {
        code: 'const fixture = { id: "fixture" } as unknown;',
        errors: [{ messageId: 'launderedObject' }],
        filename: 'file.ts',
      },
      {
        code: 'const fixture = { id: "fixture" } as any;',
        errors: [{ messageId: 'launderedObject' }],
        filename: 'file.ts',
      },
      {
        code: 'const fixture = { id: "fixture" } as unknown as Fixture;',
        errors: [{ messageId: 'launderedObject' }],
        filename: 'file.ts',
      },
      {
        code: 'const fixture = ({ id: "fixture" } as const) as unknown as Fixture;',
        errors: [{ messageId: 'launderedObject' }],
        filename: 'file.ts',
      },
      {
        code: 'const state = ("ready" as const) as WorkloadState;',
        errors: [{ messageId: 'workloadState' }],
        filename: 'file.ts',
      },
    ],
  },
);

describe('object-literal assertion ESLint configuration', () => {
  const eslint = new FlatESLint({ cwd: process.cwd() });
  const assertionRuleIds = async (code, filePath) => {
    const [result] = await eslint.lintText(code, { filePath });
    return result.messages
      .map(({ ruleId }) => ruleId)
      .filter(
        (ruleId) => ruleId === '@typescript-eslint/consistent-type-assertions',
      );
  };

  it.each([
    'src/api/services/api-health.ts',
    'test/unit/services/monitor.spec.ts',
  ])('rejects an object-literal cast in %s', async (filePath) => {
    expect(
      await assertionRuleIds(
        'const fixture = { id: "fixture" } as Fixture;',
        filePath,
      ),
    ).toEqual(['@typescript-eslint/consistent-type-assertions']);
  });

  it('rejects an angle-bracket assertion', async () => {
    expect(
      await assertionRuleIds(
        'const fixture = <Fixture>value;',
        'src/api/services/api-health.ts',
      ),
    ).toEqual(['@typescript-eslint/consistent-type-assertions']);
  });

  it.each([
    'const fixture = { id: "fixture" } as const;',
    'const fixture: Fixture = { id: "fixture" };',
    'const state = value as WorkloadState;',
  ])('allows the checked alternatives: %s', async (code) => {
    expect(
      await assertionRuleIds(code, 'src/api/services/api-health.ts'),
    ).toEqual([]);
  });
});

ruleTester.run(
  'no-test-mode-in-provider-runtime',
  localPlugin.rules['no-test-mode-in-provider-runtime'],
  {
    valid: [
      {
        code: 'if (runtime.isAvailable()) start();',
        filename: 'src/api/services/gateways/local.ts',
      },
      {
        code: 'const runtime = deps.runtime ?? createRuntime(config);',
        filename: 'src/api/services/gateways/local.ts',
      },
    ],
    invalid: [
      {
        code: "if (process.env.IS_TEST === 'true') enableLocal();",
        errors: [{ messageId: 'testMode' }],
        filename: 'src/api/services/cloud-config.ts',
      },
      {
        code: "const enabled = process.env['IS_TEST'] === 'true';",
        errors: [{ messageId: 'testMode' }],
        filename: 'src/api/services/cloud-config.ts',
      },
      {
        code: 'const enabled = config.isTest;',
        errors: [{ messageId: 'testMode' }],
        filename: 'src/api/services/cloud-config.ts',
      },
      {
        code: "const enabled = config['isTest'];",
        errors: [{ messageId: 'testMode' }],
        filename: 'src/api/services/cloud-config.ts',
      },
      {
        code: 'const { isTest: enabled } = config;',
        errors: [{ messageId: 'testMode' }],
        filename: 'src/api/services/cloud-config.ts',
      },
    ],
  },
);

const workloadAdmissionWriteOwnershipOptions = {
  allowedFiles: ['src/api/services/workload-admission-persistence.ts'],
};

ruleTester.run(
  'workload-admission-write-ownership',
  localPlugin.rules['workload-admission-write-ownership'],
  {
    valid: [
      {
        code: 'store.upsertCredential(id, encrypted, provider); store.createWorkload(input);',
        filename: 'src/api/services/workload-admission-persistence.ts',
        options: [workloadAdmissionWriteOwnershipOptions],
      },
      {
        code: 'store.getWorkload(id); persistence.createCluster(input);',
        filename: 'src/api/services/workload-admission-plan.ts',
        options: [workloadAdmissionWriteOwnershipOptions],
      },
      {
        code: 'const analytics = { createWorkload() {} }; analytics.createWorkload();',
        filename: 'src/api/services/workload-admission-plan.ts',
        options: [workloadAdmissionWriteOwnershipOptions],
      },
    ],
    invalid: [
      {
        code: "import { getWorkloadAdmissionWriter } from './workload-admission-writer.js'; getWorkloadAdmissionWriter().createTargetedWorkload(input);",
        filename: 'src/api/services/workload-admission-plan.ts',
        options: [workloadAdmissionWriteOwnershipOptions],
        errors: [
          { messageId: 'owner', data: { method: 'createTargetedWorkload' } },
        ],
      },
      {
        code: "import { getWorkloadAdmissionWriter } from './workload-admission-writer.js'; getWorkloadAdmissionWriter().upsertCredential(id, encrypted, provider);",
        filename: 'src/api/services/workload-admission-resolution.ts',
        options: [workloadAdmissionWriteOwnershipOptions],
        errors: [{ messageId: 'owner', data: { method: 'upsertCredential' } }],
      },
      {
        code: "import { getWorkloadAdmissionWriter } from './workload-admission-writer.js'; const store = getWorkloadAdmissionWriter(); store.createWorkload(input);",
        filename: 'src/api/services/workload-admission-plan.ts',
        options: [workloadAdmissionWriteOwnershipOptions],
        errors: [{ messageId: 'owner', data: { method: 'createWorkload' } }],
      },
      {
        code: "import { getWorkloadAdmissionWriter } from './workload-admission-writer.js'; const store = getWorkloadAdmissionWriter(); const create = store.createWorkload; create(input);",
        filename: 'src/api/services/workload-admission-plan.ts',
        options: [workloadAdmissionWriteOwnershipOptions],
        errors: [{ messageId: 'owner', data: { method: 'createWorkload' } }],
      },
      {
        code: "import { getWorkloadAdmissionWriter } from './workload-admission-writer.js'; const store = getWorkloadAdmissionWriter(); const { createWorkload: create } = store; create(input);",
        filename: 'src/api/services/workload-admission-plan.ts',
        options: [workloadAdmissionWriteOwnershipOptions],
        errors: [{ messageId: 'owner', data: { method: 'createWorkload' } }],
      },
      {
        code: "import { getWorkloadAdmissionWriter } from './workload-admission-writer.js'; const store = getWorkloadAdmissionWriter(); Reflect.get(store, 'createWorkload')(input);",
        filename: 'src/api/services/workload-admission-plan.ts',
        options: [workloadAdmissionWriteOwnershipOptions],
        errors: [{ messageId: 'owner', data: { method: 'createWorkload' } }],
      },
      {
        code: "import { getWorkloadAdmissionWriter } from './workload-admission-writer.js'; const store = getWorkloadAdmissionWriter(); const create = store['createWorkload']; create(input);",
        filename: 'src/api/services/workload-admission-plan.ts',
        options: [workloadAdmissionWriteOwnershipOptions],
        errors: [{ messageId: 'owner', data: { method: 'createWorkload' } }],
      },
    ],
  },
);

const environmentAccessOptions = {
  ownerFiles: ['src/api/config.ts'],
  exceptions: [
    {
      file: 'src/api/server.ts',
      variables: ['IS_TEST', 'SQLITE_PATH'],
      indirectVariables: ['API_NOTIFICATION_LABEL_ENV'],
    },
  ],
};

ruleTester.run(
  'environment-access-ownership',
  localPlugin.rules['environment-access-ownership'],
  {
    valid: [
      {
        code: 'const value = process.env[name];',
        filename: 'src/api/config.ts',
        options: [environmentAccessOptions],
      },
      {
        code: 'const enabled = process.env.IS_TEST;',
        filename: 'src/api/server.ts',
        options: [environmentAccessOptions],
      },
      {
        code: "process.env['SQLITE_PATH'] = path;",
        filename: 'src/api/server.ts',
        options: [environmentAccessOptions],
      },
      {
        code: 'process.env[API_NOTIFICATION_LABEL_ENV] = label;',
        filename: 'src/api/server.ts',
        options: [environmentAccessOptions],
      },
      {
        code: 'const value = request.env.IS_TEST;',
        filename: 'src/api/services/example.ts',
        options: [environmentAccessOptions],
      },
      {
        code: 'function read(process) { return process.env.SECRET; }',
        filename: 'src/api/services/example.ts',
        options: [environmentAccessOptions],
      },
      {
        code: 'const runtimeProcess = process; const enabled = runtimeProcess.env.IS_TEST;',
        filename: 'src/api/server.ts',
        options: [environmentAccessOptions],
      },
      {
        code: 'const Reflect = { get: (value) => value }; Reflect.get(request).env.SECRET;',
        filename: 'src/api/services/example.ts',
        options: [environmentAccessOptions],
      },
    ],
    invalid: [
      {
        code: 'const secret = process.env.SECRET;',
        errors: [
          {
            messageId: 'environmentAccess',
            data: { variable: 'SECRET' },
          },
        ],
        filename: 'src/api/services/example.ts',
        options: [environmentAccessOptions],
      },
      {
        code: 'const secret = process.env.SECRET;',
        errors: [
          {
            messageId: 'environmentAccess',
            data: { variable: 'SECRET' },
          },
        ],
        filename: 'src/api/server.ts',
        options: [environmentAccessOptions],
      },
      {
        code: 'const value = process.env[name];',
        errors: [
          {
            messageId: 'indirectEnvironmentAccess',
            data: { variable: 'name' },
          },
        ],
        filename: 'src/api/services/example.ts',
        options: [environmentAccessOptions],
      },
      // An identifier approval is a spelling, not a variable: the same file
      // stays blocked from an indirect read it did not declare, and the
      // approval does not leak into another file.
      {
        code: 'const value = process.env[SOME_OTHER_ENV];',
        errors: [
          {
            messageId: 'indirectEnvironmentAccess',
            data: { variable: 'SOME_OTHER_ENV' },
          },
        ],
        filename: 'src/api/server.ts',
        options: [environmentAccessOptions],
      },
      {
        code: 'process.env[API_NOTIFICATION_LABEL_ENV] = label;',
        errors: [
          {
            messageId: 'indirectEnvironmentAccess',
            data: { variable: 'API_NOTIFICATION_LABEL_ENV' },
          },
        ],
        filename: 'src/api/services/example.ts',
        options: [environmentAccessOptions],
      },
      {
        code: 'const value = process.env[keys[0]];',
        errors: [{ messageId: 'computedEnvironmentAccess' }],
        filename: 'src/api/services/example.ts',
        options: [environmentAccessOptions],
      },
      {
        code: 'const { IS_TEST } = process.env;',
        errors: [{ messageId: 'computedEnvironmentAccess' }],
        filename: 'src/api/services/example.ts',
        options: [environmentAccessOptions],
      },
      {
        code: 'const secret = globalThis.process.env.SECRET;',
        errors: [{ messageId: 'environmentAccess' }],
        filename: 'src/api/services/example.ts',
        options: [environmentAccessOptions],
      },
      {
        code: 'const runtimeProcess = process; const secret = runtimeProcess.env.SECRET;',
        errors: [{ messageId: 'environmentAccess' }],
        filename: 'src/api/services/example.ts',
        options: [environmentAccessOptions],
      },
      {
        code: "const secret = Reflect.get(process, 'env').SECRET;",
        errors: [{ messageId: 'environmentAccess' }],
        filename: 'src/api/services/example.ts',
        options: [environmentAccessOptions],
      },
      {
        code: "const secret = Reflect.get(process.env, 'SECRET');",
        errors: [{ messageId: 'environmentAccess' }],
        filename: 'src/api/services/example.ts',
        options: [environmentAccessOptions],
      },
      {
        code: 'const runtimeEnv = process.env; const secret = runtimeEnv.SECRET;',
        errors: [
          { messageId: 'computedEnvironmentAccess' },
          { messageId: 'environmentAccess' },
        ],
        filename: 'src/api/services/example.ts',
        options: [environmentAccessOptions],
      },
      {
        code: 'const { env: runtimeEnv } = process; const secret = runtimeEnv.SECRET;',
        errors: [
          { messageId: 'computedEnvironmentAccess' },
          { messageId: 'environmentAccess' },
        ],
        filename: 'src/api/services/example.ts',
        options: [environmentAccessOptions],
      },
      {
        code: "import { env } from 'node:process';",
        errors: [{ messageId: 'computedEnvironmentAccess' }],
        filename: 'src/api/services/example.ts',
        options: [environmentAccessOptions],
      },
      {
        code: "import runtimeProcess from 'node:process'; const secret = runtimeProcess.env.SECRET;",
        errors: [{ messageId: 'environmentAccess' }],
        filename: 'src/api/services/example.ts',
        options: [environmentAccessOptions],
      },
      {
        code: 'const { env: runtimeEnv = {} } = process; const secret = runtimeEnv.SECRET;',
        errors: [
          { messageId: 'computedEnvironmentAccess' },
          { messageId: 'environmentAccess' },
        ],
        filename: 'src/api/services/example.ts',
        options: [environmentAccessOptions],
      },
      {
        code: 'const { process: runtimeProcess = fallback } = globalThis; const secret = runtimeProcess.env.SECRET;',
        errors: [{ messageId: 'environmentAccess' }],
        filename: 'src/api/services/example.ts',
        options: [environmentAccessOptions],
      },
      {
        code: "const { get: read } = Reflect; const secret = read(process, 'env').SECRET;",
        errors: [{ messageId: 'environmentAccess' }],
        filename: 'src/api/services/example.ts',
        options: [environmentAccessOptions],
      },
      {
        code: "const read = Reflect.get.bind(Reflect); const secret = read.call(null, process, 'env').SECRET;",
        errors: [{ messageId: 'environmentAccess' }],
        filename: 'src/api/services/example.ts',
        options: [environmentAccessOptions],
      },
    ],
  },
);

ruleTester.run(
  'require-e2e-fixture',
  localPlugin.rules['require-e2e-fixture'],
  {
    valid: [
      'import { test, expect } from "../fixture.js"; test("works", async ({ e2e }) => { expect(e2e).toBeDefined(); });',
      {
        code: 'import { test, expect } from "../../../fixture.js"; test("works", async ({ e2e }) => { expect(e2e).toBeDefined(); });',
        filename:
          '/repo/test/integration/e2e/specs/contracts/persistent-vm/aws-vm.spec.ts',
      },
    ],
    invalid: [
      {
        code: 'import { test, expect } from "vitest";',
        errors: [{ messageId: 'missing' }, { messageId: 'fixtureOnly' }],
      },
      {
        code: 'test("works", async ({ e2e }) => { void e2e; });',
        errors: [{ messageId: 'missing' }],
      },
      {
        code: 'import { test, expect } from "../fixture.js"; import fs from "node:fs";',
        errors: [{ messageId: 'singleImport' }, { messageId: 'fixtureOnly' }],
      },
      {
        code: 'import { test as base, expect } from "../fixture.js";',
        errors: [{ messageId: 'bindings' }],
      },
      {
        code: 'import { test, expect } from "../fixture.js";',
        errors: [{ messageId: 'missing' }, { messageId: 'fixtureOnly' }],
        filename:
          '/repo/test/integration/e2e/specs/contracts/persistent-vm/aws-vm.spec.ts',
      },
    ],
  },
);

ruleTester.run(
  'no-e2e-adapter-escape-hatches',
  localPlugin.rules['no-e2e-adapter-escape-hatches'],
  {
    valid: [
      {
        // Methods are the legitimate adapter shape; only a function-typed
        // property lets a contract hand an adapter behaviour.
        code: 'export interface ServeTargetAdapter { submit(ref: Ref): Promise<void>; }',
        filename: '/repo/test/integration/e2e/internal/targets/serve-types.ts',
      },
      {
        code: 'export interface ReadyServe { readonly publishesDns: boolean; }',
        filename: '/repo/test/integration/e2e/internal/contracts/serve.ts',
      },
      {
        code: 'export interface Options { readonly onDone: () => void; }',
        filename: '/repo/test/integration/e2e/internal/wait.ts',
      },
    ],
    invalid: [
      {
        code: 'export interface ServeTargetAdapter { readonly observe: (ref: Ref) => Promise<void>; }',
        errors: [{ messageId: 'callback' }],
        filename: '/repo/test/integration/e2e/internal/targets/serve-types.ts',
      },
      {
        code: 'export interface ServeStageDependencies { readonly skipDnsAssertion: boolean; }',
        errors: [{ messageId: 'flag' }],
        filename: '/repo/test/integration/e2e/internal/contracts/serve.ts',
      },
    ],
  },
);

ruleTester.run(
  'no-e2e-single-member-target-union',
  localPlugin.rules['no-e2e-single-member-target-union'],
  {
    valid: [
      {
        code: 'export type ServeTarget = LocalSmolvmServeTarget | PublicCloudServeTarget;',
        filename: '/repo/test/integration/e2e/internal/targets/serve-types.ts',
      },
      {
        // One substrate is declared as that substrate, not as a union of one.
        code: "export interface ManagedGpuTarget { readonly kind: 'managed-gpu'; }",
        filename:
          '/repo/test/integration/e2e/internal/targets/managed-gpu-types.ts',
      },
      {
        code: "export type PersistentVmTarget = VmProvider | 'local-smolvm';",
        filename:
          '/repo/test/integration/e2e/internal/targets/persistent-vm-types.ts',
      },
    ],
    invalid: [
      {
        code: 'export type ExampleTarget = OnlyTarget;',
        errors: [{ messageId: 'alias' }],
        filename: '/repo/test/integration/e2e/internal/targets/example.ts',
      },
    ],
  },
);

ruleTester.run(
  'no-e2e-raw-mutation-clients',
  localPlugin.rules['no-e2e-raw-mutation-clients'],
  {
    valid: [
      {
        code: 'import type { WorkloadKernel, TrackedWorkloadRef } from "../workloads.js";',
        filename:
          '/repo/test/integration/e2e/internal/contracts/persistent-vm.ts',
      },
      {
        code: 'import type { HostIdentityCapability } from "../host-identity.js";',
        filename:
          '/repo/test/integration/e2e/internal/contracts/persistent-vm.ts',
      },
      {
        code: 'import type { CapturedSshHostIdentity, SshHostIdentityObservation } from "../host-identity.js";',
        filename:
          '/repo/test/integration/e2e/internal/contracts/persistent-vm-host-release.ts',
      },
      {
        code: 'import type { WorkloadCliCreateTransport } from "../workload-mutations.js";',
        filename:
          '/repo/test/integration/e2e/internal/targets/public-cloud-vm.ts',
      },
      {
        code: 'import type { WorkloadCliCreateTransport, WorkloadCliUpgradeTransport } from "../workload-mutations.js";',
        filename:
          '/repo/test/integration/e2e/internal/targets/public-cloud-serve.ts',
      },
      {
        code: 'import type { NodePoolCreateTransport, NodePoolDeleteAttemptTransport, NodePoolDeleteTransport } from "../node-pool-mutations.js";',
        filename:
          '/repo/test/integration/e2e/internal/targets/cluster-node-pool.ts',
      },
      {
        code: 'import type { DeploymentCreateInput, DeploymentCreateTransport, DeploymentDeleteTransport, DeploymentReadTransport, DeploymentUpdateInput, DeploymentUpdateTransport } from "../deployment-mutations.js";',
        filename:
          '/repo/test/integration/e2e/internal/targets/cluster-node-pool.ts',
      },
      {
        code: 'import type { DeploymentKernel, TrackedDeploymentRef } from "../deployments.js";',
        filename:
          '/repo/test/integration/e2e/internal/contracts/cluster-local.ts',
      },
      {
        code: 'import type { NodePoolKernel, TrackedNodePoolRef } from "../node-pools.js";',
        filename:
          '/repo/test/integration/e2e/internal/contracts/cluster-local.ts',
      },
      {
        code: 'import { NodePoolState } from "../../../../../src/shared/node-pools.js";',
        filename: '/repo/test/integration/e2e/internal/contracts/node-pool.ts',
      },
      {
        code: 'import type { VmProvider } from "../profiles.js";',
        filename:
          '/repo/test/integration/e2e/internal/targets/persistent-vm.ts',
      },
      {
        code: 'import type { EnvironmentProbeFixture } from "../probes/environment.js";',
        filename: '/repo/test/integration/e2e/internal/contracts/serve.ts',
      },
      {
        code: 'import { ApiClient } from "./api.js";',
        filename: '/repo/test/integration/e2e/internal/context.ts',
      },
      {
        code: 'import type { ProcessRunner } from "../process.js";',
        filename:
          '/repo/test/integration/e2e/internal/transports/public-cloud-vm.ts',
      },
      {
        code: 'import type { VmProfile } from "../profiles.js";',
        filename:
          '/repo/test/integration/e2e/internal/transports/public-cloud-vm.ts',
      },
      {
        code: 'import { WorkloadState } from "../../../../../src/shared/workload.js";',
        filename:
          '/repo/test/integration/e2e/internal/contracts/persistent-vm.ts',
      },
      {
        code: 'import type { CloudType } from "../../../../../src/shared/cloud.js";',
        filename:
          '/repo/test/integration/e2e/internal/targets/persistent-vm-types.ts',
      },
    ],
    invalid: [
      {
        code: 'import { completeCloudConfig } from "../../../../../src/shared/cloud-config.js";',
        errors: [{ messageId: 'layerImport' }],
        filename:
          '/repo/test/integration/e2e/internal/contracts/persistent-vm.ts',
      },
      {
        code: 'import type { ApiClient } from "../api.js";',
        errors: [{ messageId: 'raw' }],
        filename:
          '/repo/test/integration/e2e/internal/contracts/persistent-vm.ts',
      },
      {
        code: 'import type { CliClient } from "../cli.js";',
        errors: [{ messageId: 'raw' }],
        filename:
          '/repo/test/integration/e2e/internal/targets/public-cloud-vm.ts',
      },
      {
        code: 'import type { WorkloadMutationTransport } from "../workload-mutations.js";',
        errors: [{ messageId: 'raw' }],
        filename:
          '/repo/test/integration/e2e/internal/contracts/persistent-vm.ts',
      },
      {
        code: 'import { TrackedWorkloadKernel } from "../workloads.js";',
        errors: [{ messageId: 'kernel' }],
        filename:
          '/repo/test/integration/e2e/internal/targets/persistent-vm.ts',
      },
      {
        code: 'import { DeploymentMutationTransport } from "../deployment-mutations.js";',
        errors: [{ messageId: 'raw' }],
        filename:
          '/repo/test/integration/e2e/internal/targets/cluster-node-pool.ts',
      },
      {
        code: 'import { TrackedDeploymentKernel } from "../deployments.js";',
        errors: [{ messageId: 'kernel' }],
        filename:
          '/repo/test/integration/e2e/internal/contracts/cluster-local.ts',
      },
      {
        code: 'import { TrackedNodePoolKernel } from "../node-pools.js";',
        errors: [{ messageId: 'kernel' }],
        filename:
          '/repo/test/integration/e2e/internal/targets/cluster-node-pool.ts',
      },
      {
        code: 'import type { NodePoolMutationTransport } from "../node-pool-mutations.js";',
        errors: [{ messageId: 'raw' }],
        filename:
          '/repo/test/integration/e2e/internal/targets/cluster-node-pool.ts',
      },
      {
        code: 'import { HostIdentityHarness } from "../host-identity.js";',
        errors: [{ messageId: 'hostIdentity' }],
        filename:
          '/repo/test/integration/e2e/internal/contracts/persistent-vm.ts',
      },
      {
        code: 'import type { OpenSshHostIdentityTransport } from "../host-identity.js";',
        errors: [{ messageId: 'hostIdentity' }],
        filename:
          '/repo/test/integration/e2e/internal/contracts/persistent-vm.ts',
      },
      {
        code: 'import type { WorkloadMutationTransport } from "../workload-mutations.js";',
        errors: [{ messageId: 'raw' }],
        filename:
          '/repo/test/integration/e2e/internal/targets/public-cloud-vm.ts',
      },
      {
        code: 'import type { ProcessRunner } from "../process.js";',
        errors: [{ messageId: 'mechanic' }],
        filename:
          '/repo/test/integration/e2e/internal/targets/public-cloud-vm.ts',
      },
      {
        code: 'import type { Waiter } from "../wait.js";',
        errors: [{ messageId: 'mechanic' }],
        filename:
          '/repo/test/integration/e2e/internal/targets/public-cloud-vm.ts',
      },
      {
        code: 'import type { Environment } from "../environment.js";',
        errors: [{ messageId: 'mechanic' }],
        filename: '/repo/test/integration/e2e/internal/targets/local-smolvm.ts',
      },
      {
        code: 'import type { TargetHttpClient } from "../transports/http.js";',
        errors: [{ messageId: 'mechanic' }],
        filename: '/repo/test/integration/e2e/internal/targets/local-smolvm.ts',
      },
      {
        code: 'import type { ArtifactStore } from "../artifacts.js";',
        errors: [{ messageId: 'mechanic' }],
        filename: '/repo/test/integration/e2e/internal/targets/local-smolvm.ts',
      },
      {
        code: 'import type { VmLedgerProbe } from "../vm-ledger.js";',
        errors: [{ messageId: 'mechanic' }],
        filename:
          '/repo/test/integration/e2e/internal/targets/public-cloud-vm.ts',
      },
      {
        code: 'import type { VmProfile } from "../profiles.js";',
        errors: [{ messageId: 'mechanic' }],
        filename:
          '/repo/test/integration/e2e/internal/targets/public-cloud-vm.ts',
      },
      {
        code: 'import { NamedSecretProbeFixture } from "../probes/named-secret.js";',
        errors: [{ messageId: 'layerImport' }],
        filename:
          '/repo/test/integration/e2e/internal/targets/public-cloud-serve.ts',
      },
      {
        code: 'import { execFile } from "node:child_process";',
        errors: [{ messageId: 'layerImport' }],
        filename:
          '/repo/test/integration/e2e/internal/targets/public-cloud-vm.ts',
      },
      {
        code: 'import client from "provider-sdk";',
        errors: [{ messageId: 'layerImport' }],
        filename:
          '/repo/test/integration/e2e/internal/contracts/persistent-vm.ts',
      },
      {
        code: 'import type { PublicCloudPersistentVmTransport } from "../transports/public-cloud-vm.js";',
        errors: [{ messageId: 'layerImport' }],
        filename:
          '/repo/test/integration/e2e/internal/contracts/persistent-vm.ts',
      },
      {
        code: 'import type { E2EContext } from "../context.js";',
        errors: [{ messageId: 'layerImport' }],
        filename:
          '/repo/test/integration/e2e/internal/targets/public-cloud-vm.ts',
      },
      {
        code: 'const processModule = await import("../process.js");',
        errors: [{ messageId: 'dynamicImport' }],
        filename:
          '/repo/test/integration/e2e/internal/contracts/persistent-vm.ts',
      },
      {
        code: 'export { ProcessRunner } from "../process.js";',
        errors: [{ messageId: 'reexport' }],
        filename:
          '/repo/test/integration/e2e/internal/contracts/persistent-vm.ts',
      },
      {
        code: 'const childProcess = require("node:child_process");',
        errors: [{ messageId: 'globalCapability' }],
        filename:
          '/repo/test/integration/e2e/internal/targets/public-cloud-vm.ts',
      },
      {
        code: 'await fetch("https://provider.invalid");',
        errors: [{ messageId: 'globalCapability' }],
        filename:
          '/repo/test/integration/e2e/internal/contracts/persistent-vm.ts',
      },
      {
        code: 'setTimeout(() => undefined, 1);',
        errors: [{ messageId: 'globalCapability' }],
        filename:
          '/repo/test/integration/e2e/internal/contracts/persistent-vm.ts',
      },
    ],
  },
);

ruleTester.run(
  'no-e2e-raw-vm-ledger-access',
  localPlugin.rules['no-e2e-raw-vm-ledger-access'],
  {
    valid: [
      {
        code: 'const snapshot = vmLedger.snapshot(ref, status); const live = vmLedger.liveEntries(snapshot);',
        filename:
          '/repo/test/integration/e2e/internal/contracts/persistent-vm.ts',
      },
      {
        code: 'const rows = status.vms;',
        filename:
          '/repo/test/integration/e2e/internal/targets/public-cloud-vm.ts',
      },
    ],
    invalid: [
      {
        code: 'const rows = status.vms ?? [];',
        errors: [{ messageId: 'raw' }],
        filename:
          '/repo/test/integration/e2e/internal/contracts/persistent-vm-host-loss.ts',
      },
      {
        code: 'const { vms: rows } = status;',
        errors: [{ messageId: 'raw' }],
        filename:
          '/repo/test/integration/e2e/internal/contracts/persistent-vm.ts',
      },
    ],
  },
);

ruleTester.run(
  'valid-e2e-contract-spec',
  localPlugin.rules['valid-e2e-contract-spec'],
  {
    valid: [
      {
        code: 'import { test, expect } from "../../../fixture.js"; test("AWS contract", async ({ e2e }) => { const result = await e2e.contracts.persistentVm("aws"); expect(result).toEqual({ contract: "persistent-vm", qualification: "conclusive", target: "aws", satisfied: true }); });',
        filename:
          '/repo/test/integration/e2e/specs/contracts/persistent-vm/aws-vm.spec.ts',
      },
      {
        code: 'import { test, expect } from "../../../fixture.js"; test("AWS host loss", async ({ e2e }) => { const result = await e2e.contracts.persistentVmHostLoss("aws"); expect(result).toEqual({ contract: "persistent-vm-host-loss", qualification: "conclusive", target: "aws", satisfied: true }); });',
        filename:
          '/repo/test/integration/e2e/specs/contracts/persistent-vm-host-loss/aws-vm-host-loss.spec.ts',
      },
      {
        code: 'import { test, expect } from "../../../fixture.js"; test("AWS Serve", async ({ e2e }) => { const result = await e2e.contracts.serve("aws"); expect(result).toEqual({ contract: "serve", qualification: "conclusive", target: "aws", satisfied: true }); });',
        filename:
          '/repo/test/integration/e2e/specs/contracts/serve/aws-serve.spec.ts',
      },
      ...['aws', 'azure', 'gcp', 'lambda'].map((target) => ({
        code: `import { test, expect } from "../../../fixture.js"; test("GPU Service", async ({ e2e }) => { const result = await e2e.contracts.gpuServe("${target}"); expect(result).toEqual({ contract: "gpu-serve", qualification: "conclusive", target: "${target}", satisfied: true }); });`,
        filename: `/repo/test/integration/e2e/specs/contracts/gpu-serve/${target}-gpu-serve.spec.ts`,
      })),
      {
        code: 'import { test, expect } from "../../../fixture.js"; test("AWS Serve upgrade", async ({ e2e }) => { const result = await e2e.contracts.serveUpgrade("aws"); expect(result).toEqual({ contract: "serve-upgrade", qualification: "conclusive", target: "aws", satisfied: true }); });',
        filename:
          '/repo/test/integration/e2e/specs/contracts/serve-upgrade/aws-serve-upgrade.spec.ts',
      },
      {
        code: 'import { test, expect } from "../fixture.js"; test("direct spec", async ({ e2e }) => { expect(e2e).toBeDefined(); });',
        filename: '/repo/test/integration/e2e/specs/cli-exit.spec.ts',
      },
    ],
    invalid: [
      {
        code: 'import { test, expect } from "../../../fixture.js"; test("copied lifecycle", async ({ e2e }) => { const result = await e2e.cli.run(["vm"]); expect(result.exitCode).toBe(0); });',
        errors: [{ messageId: 'shape' }],
        filename:
          '/repo/test/integration/e2e/specs/contracts/persistent-vm/aws-vm.spec.ts',
      },
      {
        code: 'import { test, expect } from "../../../fixture.js"; test("wrong target", async ({ e2e }) => { const result = await e2e.contracts.persistentVm("gcp"); expect(result).toEqual({ contract: "persistent-vm", qualification: "conclusive", target: "gcp", satisfied: true }); });',
        errors: [{ messageId: 'shape' }],
        filename:
          '/repo/test/integration/e2e/specs/contracts/persistent-vm/aws-vm.spec.ts',
      },
      {
        code: 'import { test, expect } from "../../../fixture.js"; test("wrong host-loss target", async ({ e2e }) => { const result = await e2e.contracts.persistentVmHostLoss("gcp"); expect(result).toEqual({ contract: "persistent-vm-host-loss", qualification: "conclusive", target: "gcp", satisfied: true }); });',
        errors: [{ messageId: 'shape' }],
        filename:
          '/repo/test/integration/e2e/specs/contracts/persistent-vm-host-loss/aws-vm-host-loss.spec.ts',
      },
      {
        code: 'import { test, expect } from "../../../fixture.js"; test("extra freedom", async ({ e2e }) => { const result = await e2e.contracts.persistentVm("aws"); await e2e.workloads.status("other"); expect(result).toEqual({ contract: "persistent-vm", qualification: "conclusive", target: "aws", satisfied: true }); });',
        errors: [{ messageId: 'shape' }],
        filename:
          '/repo/test/integration/e2e/specs/contracts/persistent-vm/aws-vm.spec.ts',
      },
      {
        code: 'import { test, expect } from "../../../fixture.js"; test("unknown family", async ({ e2e }) => { expect(e2e).toBeDefined(); });',
        errors: [{ messageId: 'unsupported' }],
        filename:
          '/repo/test/integration/e2e/specs/contracts/unknown/aws-unknown.spec.ts',
      },
      {
        code: 'import { test, expect } from "../../../fixture.js"; test("wrong serve target", async ({ e2e }) => { const result = await e2e.contracts.serve("gcp"); expect(result).toEqual({ contract: "serve", qualification: "conclusive", target: "gcp", satisfied: true }); });',
        errors: [{ messageId: 'shape' }],
        filename:
          '/repo/test/integration/e2e/specs/contracts/serve/aws-serve.spec.ts',
      },
      ...[
        { method: 'gpuServe', target: 'gcp', family: 'gpu-serve', extra: '' },
        { method: 'serve', target: 'aws', family: 'gpu-serve', extra: '' },
        { method: 'gpuServe', target: 'aws', family: 'serve', extra: '' },
        {
          method: 'gpuServe',
          target: 'aws',
          family: 'gpu-serve',
          extra: 'await e2e.cli.run(["terminate", "other"]);',
        },
      ].map(({ method, target, family, extra }) => ({
        code: `import { test, expect } from "../../../fixture.js"; test("invalid GPU Service", async ({ e2e }) => { const result = await e2e.contracts.${method}("${target}"); ${extra} expect(result).toEqual({ contract: "${family}", qualification: "conclusive", target: "${target}", satisfied: true }); });`,
        errors: [{ messageId: 'shape' }],
        filename:
          '/repo/test/integration/e2e/specs/contracts/gpu-serve/aws-gpu-serve.spec.ts',
      })),
      {
        code: 'import { test, expect } from "../../../fixture.js";',
        errors: [{ messageId: 'shape' }],
        filename:
          '/repo/test/integration/e2e/specs/contracts/persistent-vm/aws-vm.spec.ts',
      },
    ],
  },
);

ruleTester.run(
  'closed-dedicated-job-spec',
  localPlugin.rules['valid-e2e-contract-spec'],
  {
    valid: [
      ...['aws', 'azure', 'gcp'].map((target) => ({
        filename: `/repo/test/integration/e2e/specs/contracts/dedicated-job/${target}-invalid.spec.ts`,
        code: `import { test, expect } from "../../../fixture.js"; test("Admission Job", async ({ e2e }) => { const result = await e2e.contracts.dedicatedJob({ kind: "invalid-admission", target: "${target}" }); expect(result).toEqual({ contract: "dedicated-job", member: { kind: "invalid-admission", target: "${target}" }, target: "${target}", qualification: "conclusive", satisfied: true }); });`,
      })),
      ...['aws', 'azure', 'gcp'].map((target) => ({
        filename: `/repo/test/integration/e2e/specs/contracts/dedicated-job/${target}-job-host-unreachable.spec.ts`,
        code: `import { test, expect } from "../../../fixture.js"; test("Host Job", async ({ e2e }) => { const result = await e2e.contracts.dedicatedJob({ kind: "host-recovery", target: "${target}" }); expect(result).toEqual({ contract: "dedicated-job", member: { kind: "host-recovery", target: "${target}" }, target: "${target}", qualification: "conclusive", satisfied: true }); });`,
      })),
      ...['held', 'completed', 'resubmitted'].map((member) => ({
        filename: `/repo/test/integration/e2e/specs/contracts/dedicated-job/local-${member}-job.spec.ts`,
        code: `import { test, expect } from "../../../fixture.js"; test("Local Job", async ({ e2e }) => { const result = await e2e.contracts.dedicatedJob({ kind: "local-${member}", target: "local-smolvm" }); expect(result).toEqual({ contract: "dedicated-job", member: { kind: "local-${member}", target: "local-smolvm" }, target: "local-smolvm", qualification: "conclusive", satisfied: true }); });`,
      })),
      ...[
        ['bucket-sync', 'aws'],
        ['bucket-sync', 'azure'],
        ['bucket-sync', 'gcp'],
        ['bucket-sync', 'lambda'],
        ['concurrent-output', 'aws'],
        ['concurrent-output', 'azure'],
        ['concurrent-output', 'gcp'],
        ['disk-tier', 'gcp'],
        ['host-docker', 'aws'],
        ['host-docker', 'azure'],
        ['host-docker', 'gcp'],
      ].map(([kind, target]) => ({
        filename: `/repo/test/integration/e2e/specs/contracts/dedicated-job/${target}-${kind}.spec.ts`,
        code: `import { test, expect } from "../../../fixture.js"; test("Cloud Job", async ({ e2e }) => { const result = await e2e.contracts.dedicatedJob({ kind: "${kind}", target: "${target}" }); expect(result).toEqual({ contract: "dedicated-job", member: { kind: "${kind}", target: "${target}" }, target: "${target}", qualification: "conclusive", satisfied: true }); });`,
      })),
    ],
    invalid: [
      '{ kind: "local-held", target: "aws" }',
      '{ kind: "local-held", target: "local-smolvm", timeout: 1 }',
      '{ ...selection }',
      '{ kind: "local-held", kind: "local-held" }',
      '{ get kind() { return "local-held"; }, target: "local-smolvm" }',
      'selection',
      '"local-smolvm"',
    ].map((selection) => ({
      filename:
        '/repo/test/integration/e2e/specs/contracts/dedicated-job/local-held-job.spec.ts',
      code: `import { test, expect } from "../../../fixture.js"; test("invalid Job", async ({ e2e }) => { const result = await e2e.contracts.dedicatedJob(${selection}); expect(result).toEqual({ contract: "dedicated-job", member: { kind: "local-held", target: "local-smolvm" }, target: "local-smolvm", qualification: "conclusive", satisfied: true }); });`,
      errors: [{ messageId: 'shape' }],
    })),
  },
);

ruleTester.run(
  'closed-cloud-job-spec',
  localPlugin.rules['valid-e2e-contract-spec'],
  {
    valid: [],
    invalid: [
      ['aws-invalid', '{ kind: "invalid-admission", target: "gcp" }', 'aws'],
      ['gcp-disk-tier', '{ kind: "disk-tier", target: "aws" }', 'gcp'],
      ['azure-ghcr-probe', '{ kind: "ghcr-probe", target: "gcp" }', 'azure'],
      [
        'azure-ghcr-probe',
        '{ kind: "ghcr-probe", target: "azure", measureBaseline: true }',
        'azure',
      ],
      [
        'aws-mace-full-pull',
        '{ kind: "mace-full-pull", target: "gcp" }',
        'aws',
      ],
      [
        'lambda-mace-full-pull',
        '{ kind: "mace-full-pull", target: "lambda", holdSeconds: 60 }',
        'lambda',
      ],
      [
        'gcp-disk-tier',
        '{ kind: "disk-tier", target: "gcp", cases: ["u"] }',
        'gcp',
      ],
      [
        'azure-invalid',
        '{ kind: "invalid-admission", target: "azure", vmType: "Standard_D2s_v5" }',
        'azure',
      ],
      [
        'gcp-invalid',
        '{ kind: "invalid-admission", target: "gcp", expectedMessage: "permission denied" }',
        'gcp',
      ],
      [
        'aws-job-host-unreachable',
        '{ kind: "host-recovery", target: "azure" }',
        'aws',
      ],
      [
        'aws-input-hydration-recovery',
        '{ kind: "input-hydration-recovery", target: "gcp" }',
        'aws',
      ],
      [
        'aws-input-hydration-recovery',
        '{ kind: "input-hydration-recovery", target: "aws", shardCount: 2 }',
        'aws',
      ],
      [
        'azure-job-host-unreachable',
        '{ kind: "host-recovery", target: "azure", checkpointRegion: "westus2" }',
        'azure',
      ],
      [
        'gcp-job-host-unreachable',
        '{ kind: "host-recovery", target: "gcp", cleanupMs: 1 }',
        'gcp',
      ],
      [
        'azure-spot-eviction',
        '{ kind: "spot-eviction", target: "gcp" }',
        'azure',
      ],
      ['aws-bucket-sync', '{ kind: "bucket-sync", target: "azure" }', 'aws'],
      [
        'aws-bucket-sync',
        '{ kind: "bucket-sync", target: "aws", vmTypes: ["t3.large"] }',
        'aws',
      ],
      [
        'aws-concurrent-output',
        '{ kind: "bucket-sync", target: "aws" }',
        'aws',
      ],
      [
        'lambda-concurrent-output',
        '{ kind: "concurrent-output", target: "lambda" }',
        'lambda',
      ],
    ].map(([filename, selection, target]) => ({
      filename: `/repo/test/integration/e2e/specs/contracts/dedicated-job/${filename}.spec.ts`,
      code: `import { test, expect } from "../../../fixture.js"; test("invalid cloud Job", async ({ e2e }) => { const result = await e2e.contracts.dedicatedJob(${selection}); expect(result).toEqual({ contract: "dedicated-job", member: { kind: "bucket-sync", target: "${target}" }, target: "${target}", qualification: "conclusive", satisfied: true }); });`,
      errors: [
        {
          messageId:
            filename === 'lambda-concurrent-output' ? 'unsupported' : 'shape',
        },
      ],
    })),
  },
);

ruleTester.run(
  'valid-e2e-spec-shape',
  localPlugin.rules['valid-e2e-spec-shape'],
  {
    valid: [
      'import { test, expect } from "../fixture.js"; test("works", async ({ e2e }) => { expect(e2e).toBeDefined(); });',
      'import { test, expect } from "../fixture.js"; test("one", async ({ e2e }) => { expect(e2e).toBeDefined(); }); test("two", async ({ e2e }) => { expect(e2e).toBeDefined(); });',
    ],
    invalid: [
      {
        code: 'import { test, expect } from "../fixture.js"; const timeout = 5; test("works", async ({ e2e }) => { expect(e2e).toBeDefined(); });',
        errors: [{ messageId: 'topLevel' }],
      },
      {
        code: 'import { test, expect } from "../fixture.js"; test("works", ({ e2e }) => { expect(e2e).toBeDefined(); });',
        errors: [{ messageId: 'callback' }],
      },
      {
        code: 'import { test, expect } from "../fixture.js"; test("works", async ({ e2e, task }) => { expect(e2e).toBeDefined(); expect(task).toBeDefined(); });',
        errors: [{ messageId: 'callback' }],
      },
      {
        code: 'import { test, expect } from "../fixture.js"; test("outer", async ({ e2e }) => { test("inner", async ({ e2e }) => { expect(e2e).toBeDefined(); }); expect(e2e).toBeDefined(); });',
        errors: [{ messageId: 'nested' }],
      },
      {
        code: 'import { test, expect } from "../fixture.js"; test("works", async ({ e2e }) => { beforeEach(() => e2e.reset()); expect(e2e).toBeDefined(); });',
        errors: [{ messageId: 'forbiddenApi' }],
      },
      {
        code: 'import { test, expect } from "../fixture.js";',
        errors: [{ messageId: 'missing' }],
      },
    ],
  },
);

ruleTester.run(
  'no-e2e-escape-hatches',
  localPlugin.rules['no-e2e-escape-hatches'],
  {
    valid: [
      'import { test, expect } from "../fixture.js"; test("works", async ({ e2e }) => { const result = await e2e.cli.run(["--help"]); expect(result.exitCode).toBe(0); });',
    ],
    invalid: [
      {
        code: 'process.env.API_URL;',
        errors: [{ messageId: 'global', data: { name: 'process' } }],
      },
      {
        code: 'await fetch("https://example.com");',
        errors: [{ messageId: 'global', data: { name: 'fetch' } }],
      },
      {
        code: 'setTimeout(() => {}, 10);',
        errors: [{ messageId: 'global', data: { name: 'setTimeout' } }],
      },
      {
        code: 'await import("node:fs");',
        errors: [{ messageId: 'dynamicImport' }],
      },
      {
        code: '// eslint-disable-next-line no-undef\nunknownGlobal();',
        errors: [{ messageId: 'comment' }],
      },
      {
        code: 'vi.mock("dependency");',
        errors: [{ messageId: 'global', data: { name: 'vi' } }],
      },
    ],
  },
);
const contractBuilderOwner = {
  allowedFiles: ['src/shared/api-contract/base.ts'],
  checkBuilderCalls: true,
};
const contractBuilderImportsOnly = {
  allowedFiles: ['src/shared/api-contract/base.ts'],
  checkBuilderCalls: false,
};

ruleTester.run(
  'api-contract-builder-ownership',
  localPlugin.rules['api-contract-builder-ownership'],
  {
    valid: [
      {
        code: "import { oc } from '@orpc/contract'; oc.route({ method: 'GET', path: '/' }).meta({});",
        filename: 'src/shared/api-contract/base.ts',
        options: [contractBuilderOwner],
      },
      {
        code: "import { oc as builder } from '@orpc/contract'; const contract = builder.errors({}); contract['route']({ method: 'GET', path: '/' });",
        filename: 'src/shared/api-contract/base.ts',
        options: [contractBuilderOwner],
      },
      {
        code: "const router = express.Router(); router.route('/items'); const model = schema.meta();",
        filename: 'src/api/routes/example.ts',
        options: [contractBuilderImportsOnly],
      },
    ],
    invalid: [
      {
        code: "import { oc } from '@orpc/contract'; oc.route({ method: 'GET', path: '/' });",
        errors: [
          { messageId: 'ocImport' },
          { messageId: 'builder', data: { method: 'route' } },
        ],
        filename: 'src/shared/api-contract/items.ts',
        options: [contractBuilderOwner],
      },
      {
        code: "import { contractBuilder } from './foundation.js'; contractBuilder.route({ method: 'GET', path: '/' });",
        errors: [{ messageId: 'builder', data: { method: 'route' } }],
        filename: 'src/shared/api-contract/items.ts',
        options: [contractBuilderOwner],
      },
      {
        code: "import { oc } from '@orpc/contract'; const { route } = oc; route({ method: 'GET', path: '/' });",
        errors: [{ messageId: 'ocImport' }],
        filename: 'src/shared/api-contract/items.ts',
        options: [contractBuilderOwner],
      },
      {
        code: "import { oc as builder } from './foundation.js'; const { route } = builder; route({ method: 'GET', path: '/' });",
        errors: [{ messageId: 'ocImport' }],
        filename: 'src/shared/api-contract/items.ts',
        options: [contractBuilderOwner],
      },
      {
        code: "import * as orpc from '@orpc/contract'; orpc.oc['route']({ method: 'GET', path: '/' });",
        errors: [
          { messageId: 'ocImport' },
          { messageId: 'builder', data: { method: 'route' } },
        ],
        filename: 'src/shared/api-contract/items.ts',
        options: [contractBuilderOwner],
      },
      {
        code: "import { contractBuilder } from './foundation.js'; contractBuilder['meta']({});",
        errors: [{ messageId: 'builder', data: { method: 'meta' } }],
        filename: 'src/shared/api-contract/items.ts',
        options: [contractBuilderOwner],
      },
      {
        code: "contractBuilder.route({ method: 'GET', path: '/' });",
        errors: [{ messageId: 'builder', data: { method: 'route' } }],
        filename: '/tmp/repo/src/shared/api-contract/base.ts',
        options: [contractBuilderOwner],
      },
      {
        code: "export { oc as contractBuilder } from '@orpc/contract';",
        errors: [{ messageId: 'ocExport' }],
        filename: 'src/shared/api-contract/base.ts',
        options: [contractBuilderOwner],
      },
      {
        code: "export { oc as contractBuilder } from './foundation.js';",
        errors: [{ messageId: 'ocExport' }],
        filename: 'src/shared/api-contract/items.ts',
        options: [contractBuilderOwner],
      },
      {
        code: "import { oc } from '@orpc/contract'; export { oc as contractBuilder };",
        errors: [{ messageId: 'ocExport' }],
        filename: 'src/shared/api-contract/base.ts',
        options: [contractBuilderOwner],
      },
    ],
  },
);

const contractInspectionOwner = {
  allowedFiles: ['src/shared/services/api-client/rpc.ts'],
};

ruleTester.run(
  'api-contract-inspection-ownership',
  localPlugin.rules['api-contract-inspection-ownership'],
  {
    valid: [
      {
        code: "import { getContractRouter as resolve } from '@orpc/contract'; const procedure = resolve(contract, path); const metadata = procedure['~orpc'].meta;",
        filename: 'src/shared/services/api-client/rpc.ts',
        options: [contractInspectionOwner],
      },
      {
        code: 'const getContractRouter = localResolver; getContractRouter(contract); const metadata = procedure.meta;',
        filename: 'src/shared/example.ts',
        options: [contractInspectionOwner],
      },
    ],
    invalid: [
      {
        code: "import { getContractRouter as resolve } from '@orpc/contract'; resolve(contract, path);",
        errors: [{ messageId: 'resolver' }],
        filename: 'src/shared/example.ts',
        options: [contractInspectionOwner],
      },
      {
        code: "import * as orpc from '@orpc/contract'; const contractApi = orpc; contractApi['getContractRouter'](contract, path);",
        errors: [{ messageId: 'resolver' }],
        filename: 'src/shared/example.ts',
        options: [contractInspectionOwner],
      },
      {
        code: "const internals = procedure['~orpc']; const metadata = internals.meta;",
        errors: [{ messageId: 'internals' }],
        filename: 'src/shared/example.ts',
        options: [contractInspectionOwner],
      },
      {
        code: "const alias = procedure; const errors = alias['~orpc']['errorMap'];",
        errors: [{ messageId: 'internals' }],
        filename: 'src/shared/example.ts',
        options: [contractInspectionOwner],
      },
      {
        code: "const metadata = procedure['~orpc'].meta;",
        errors: [{ messageId: 'internals' }],
        filename: '/tmp/repo/src/shared/services/api-client/rpc.ts',
        options: [contractInspectionOwner],
      },
    ],
  },
);

ruleTester.run(
  'no-uncontracted-api-routes',
  localPlugin.rules['no-uncontracted-api-routes'],
  {
    valid: [
      {
        code: "import { Router } from 'express'; const router = Router(); router.use(authenticate);",
      },
      {
        code: "const cache = new Map(); cache.get('key');",
      },
      {
        code: "import type { Router } from 'express'; const router = Router(); router.post('/items', handler);",
        filename: 'file.ts',
      },
      {
        code: "import express from 'express'; const app = express(); app.get('/health', handler);",
        filename: 'src/api/server.ts',
        options: [{ allowedFiles: ['src/api/server.ts'] }],
      },
      {
        code: "import { Router } from 'express'; const router = Router(); function read(router) { return router.get('key'); } read(cache);",
      },
      {
        code: "import { Router } from 'express'; const router = Router(); const register = router.get; function invoke(register) { register('not-a-route'); } invoke(callback);",
      },
    ],
    invalid: [
      {
        code: "import express from 'express'; const app = express(); app.get('/items', handler);",
        errors: [{ messageId: 'route' }],
      },
      {
        code: "import { Router as makeRouter } from 'express'; const api = makeRouter(); api.post('/items', handler);",
        errors: [{ messageId: 'route' }],
      },
      {
        code: "import { Router } from 'express'; Router().put('/items/:id', handler);",
        errors: [{ messageId: 'route' }],
      },
      {
        code: "import * as express from 'express'; const router = express.Router(); const alias = router; alias['delete']('/items/:id', handler);",
        errors: [{ messageId: 'route' }],
      },
      {
        code: "import { Router } from 'express'; const router = Router(); const { post } = router; post('/items', handler);",
        errors: [{ messageId: 'route' }],
      },
      {
        code: "import { Router } from 'express'; const router = Router(); const register = router.get; register('/items', handler);",
        errors: [{ messageId: 'route' }],
      },
      {
        code: "import type { Router } from 'express'; function register(router: Router) { router.patch('/items', handler); }",
        errors: [{ messageId: 'route' }],
        filename: 'file.ts',
      },
      {
        code: "import { Router } from 'express'; const router = Router(); router[method]('/items', handler);",
        errors: [{ messageId: 'route' }],
      },
      {
        code: "import { Router } from 'express'; const router = Router(); const register = Reflect.get(router, 'post'); register('/items', handler);",
        errors: [{ messageId: 'route' }],
      },
      {
        code: "import { Router } from 'express'; const router = Router(); const { [method]: register } = router;",
        errors: [{ messageId: 'route' }],
      },
      {
        code: "import { Router } from 'express'; const router = Router(); router.route('/items').get(handler);",
        errors: [{ messageId: 'route' }],
      },
      {
        code: "import { Router } from 'express'; function register(target) { target.patch('/items', handler); } const router = Router(); register(router);",
        errors: [{ messageId: 'route' }],
      },
      {
        code: "import { Router } from 'express'; const register = (target) => { const alias = target; alias.post('/items', handler); }; register(Router());",
        errors: [{ messageId: 'route' }],
      },
      {
        code: "import { Router } from 'express'; function register({ get }) { get('/items', handler); } register(Router());",
        errors: [{ messageId: 'route' }],
      },
      {
        code: "import { Router } from 'express'; const router = Router(); router.get.call(router, '/items', handler);",
        errors: [{ messageId: 'route' }],
      },
    ],
  },
);

ruleTester.run(
  'no-hand-written-retry-loops',
  localPlugin.rules['no-hand-written-retry-loops'],
  {
    valid: [
      "await wait.for('ready', probe, { timeoutMs: 1, probeError: 'fail', unmet });",
      // Samplers pause but never stop early on success.
      'while (now() < guardDeadline) { invariant((await live()).length === 0); await spot.pause(5000); }',
      'for (let index = 0; index < 15; index++) { await hydration.pause(60000); samples.push(await sample()); }',
      // Iterating recorded attempts is not retrying.
      'for (const attempt of observation.attempts) { ids.push(attempt.id); }',
      // A sleep in a nested callback belongs to that callback.
      'for (const command of commands) { run(command, { onStdout: async () => { await new Promise((done) => setTimeout(done, 100)); } }); }',
      '// eslint-disable-next-line no-hand-written-retry-loops -- A standalone child process cannot import Waiter.\nwhile (Date.now() < deadline) { try { return await follow(); } catch { await sleep(1000); } }',
    ],
    invalid: [
      // Attempt-counted retries with a backoff schedule (credentials onboarding).
      'for (let attempt = 0; attempt <= waits.length; attempt += 1) { try { return await create(); } catch (error) { last = error; } }',
      'do { result = await run(); } while (result.exitCode !== 0 && retries-- > 0);',
      // The storage-account readback loop.
      'while ((read.status === 429 || read.status >= 500) && Date.now() + 2000 < deadline) { await session.pause(2000, deadline); read = await get(); }',
      'for (;;) { try { return await probe(); } catch { await new Promise((done) => setTimeout(done, 1000)); } }',
      'while (!(await stopped())) await session.pause(5000, deadline);',
      'for (const [index, ms] of [...SETTLE, 0].entries()) { if ((await read()).length === 0) return; await commands.wait(ms, deadline); }',
    ].map((code) => ({ code, errors: [{ messageId: 'loop' }] })),
  },
);

ruleTester.run(
  'literal-module-loads',
  localPlugin.rules['literal-module-loads'],
  {
    valid: [
      "import { readFile } from 'node:fs/promises';",
      "export { value } from './owner.js';",
      "const helper = loaders.get('alpha');",
      "import type { Module } from 'node:module';",
      "import { type Module } from 'node:module';",
      "import type { Db } from './services/repositories/db.js';",
      'outer: for (const x of xs) { break outer; }',
      "Reflect.get(config, 'loadPlugin');",
      'Reflect.get(store, key, store);',
      'Reflect.ownKeys(target);',
      'const get = Reflect.get;',
      "const mode = { sourceType: 'module' };",
      'type Handler = Function;',
    ],
    invalid: [
      {
        code: "await import('./sibling.js');",
        errors: [{ messageId: 'dynamicImport' }],
      },
      {
        code: 'await import(modulePath);',
        errors: [{ messageId: 'dynamicImport' }],
      },
      {
        code: 'await import(`./sibling.js`);',
        errors: [{ messageId: 'dynamicImport' }],
      },
      {
        code: "await import(('./sibling.js'));",
        errors: [{ messageId: 'dynamicImport' }],
      },
      {
        code: "await import('./sibling.js' as string);",
        errors: [{ messageId: 'dynamicImport' }],
      },
      {
        code: "await import('node:module');",
        errors: [{ messageId: 'dynamicImport' }],
      },
      {
        code: "import { createRequire } from 'node:module';",
        errors: [{ messageId: 'capability' }],
      },
      {
        code: "import * as nodeModule from 'module';",
        errors: [{ messageId: 'capability' }],
      },
      {
        code: "import { type Module, createRequire } from 'node:module';",
        errors: [{ messageId: 'capability' }],
      },
      {
        code: "type T = import('./services/repositories/db.js').Db;",
        errors: [{ messageId: 'typeExpression' }],
      },
      // The flat ban: the loader names cannot appear in any position.
      {
        code: "require('./x.js');",
        errors: [{ messageId: 'bannedName' }],
      },
      {
        code: 'const load = require;',
        errors: [{ messageId: 'bannedName' }],
      },
      {
        code: "require.call(null, './x.js');",
        errors: [{ messageId: 'bannedName' }],
      },
      {
        code: 'function localScope(require) { return require; }',
        errors: [{ messageId: 'bannedName' }, { messageId: 'bannedName' }],
      },
      {
        code: 'const { require } = registry;',
        errors: [{ messageId: 'bannedName' }, { messageId: 'bannedName' }],
      },
      {
        code: 'try { work(); } catch (require) {}',
        errors: [{ messageId: 'bannedName' }],
      },
      {
        code: "import { helper as require } from 'some-package';",
        errors: [{ messageId: 'bannedName' }],
      },
      {
        code: "import { require as validate } from 'some-package';",
        errors: [{ messageId: 'bannedName' }],
      },
      {
        code: 'loader.require("./x.js");',
        errors: [{ messageId: 'bannedName' }],
      },
      {
        code: 'interface Loader {\n  require(): void;\n}',
        errors: [{ messageId: 'bannedName' }],
      },
      {
        code: 'const api = { require: false };',
        errors: [{ messageId: 'bannedName' }],
      },
      {
        code: "typeof require === 'function';",
        errors: [{ messageId: 'bannedName' }],
      },
      {
        code: "module.require('../test/helper.cjs');",
        errors: [{ messageId: 'bannedName' }, { messageId: 'bannedName' }],
      },
      {
        code: 'const nodeModule = process.getBuiltinModule;',
        errors: [{ messageId: 'bannedName' }],
      },
      {
        code: 'const { getBuiltinModule } = process;',
        errors: [{ messageId: 'bannedName' }, { messageId: 'bannedName' }],
      },
      {
        code: 'const { [`getBuiltinModule`]: load } = process;',
        errors: [{ messageId: 'bannedString' }],
      },
      {
        code: "Reflect.get(process, 'getBuiltinModule');",
        errors: [{ messageId: 'bannedString' }],
      },
      {
        code: "Reflect.apply(Reflect.get, Reflect, [process, 'getBuiltinModule']);",
        errors: [{ messageId: 'bannedString' }],
      },
      {
        code: "const key = 'require';",
        errors: [{ messageId: 'bannedString' }],
      },
      {
        code: 'const F = Function;',
        errors: [{ messageId: 'bannedName' }],
      },
      {
        code: "Reflect.get(globalThis, 'eval');",
        errors: [{ messageId: 'bannedString' }],
      },
      {
        code: "import Module = require('node:module');",
        errors: [{ messageId: 'bannedName' }],
      },
      {
        code: "import 'data:text/javascript,export default 1';",
        errors: [{ messageId: 'schemeSpecifier' }],
      },
      {
        code: "import '/etc/injected.js';",
        errors: [{ messageId: 'schemeSpecifier' }],
      },
      {
        code: "import '#internal/db.js';",
        errors: [{ messageId: 'schemeSpecifier' }],
      },
      {
        code: "import type { Shape } from '/abs/types.js';",
        errors: [{ messageId: 'schemeSpecifier' }],
      },
      {
        code: "import 'file:///tmp/module.mjs';",
        errors: [{ messageId: 'schemeSpecifier' }],
      },
      {
        code: "import 'https://example.com/module.mjs';",
        errors: [{ messageId: 'schemeSpecifier' }],
      },
      {
        code: "await import('file:///tmp/module.mjs');",
        errors: [{ messageId: 'dynamicImport' }],
      },
    ],
  },
);

const protectedRules = [
  'local/api-contract-builder-ownership',
  'local/api-contract-inspection-ownership',
  'local/workload-admission-write-ownership',
  'local/workload-event-metadata-ownership',
  'local/environment-access-ownership',
  'local/literal-module-loads',
  'local/no-barrel-reexports',
  'local/no-test-mode-in-provider-runtime',
  'local/no-uncontracted-api-routes',
  'local/protected-rule-disable-policy',
  'no-eval',
  'no-implied-eval',
  'no-new-func',
  'no-restricted-imports',
  '@typescript-eslint/no-restricted-imports',
];

const protectedRuleLinter = new Linter();
protectedRuleLinter.defineRule(
  'local/api-contract-builder-ownership',
  localPlugin.rules['api-contract-builder-ownership'],
);
protectedRuleLinter.defineRule(
  'local/api-contract-inspection-ownership',
  localPlugin.rules['api-contract-inspection-ownership'],
);
protectedRuleLinter.defineRule(
  'local/workload-admission-write-ownership',
  localPlugin.rules['workload-admission-write-ownership'],
);
protectedRuleLinter.defineRule(
  'local/workload-event-metadata-ownership',
  localPlugin.rules['workload-event-metadata-ownership'],
);
protectedRuleLinter.defineRule(
  'local/environment-access-ownership',
  localPlugin.rules['environment-access-ownership'],
);
protectedRuleLinter.defineRule(
  'local/literal-module-loads',
  localPlugin.rules['literal-module-loads'],
);
protectedRuleLinter.defineRule(
  'local/no-barrel-reexports',
  localPlugin.rules['no-barrel-reexports'],
);
protectedRuleLinter.defineRule(
  'local/no-test-mode-in-provider-runtime',
  localPlugin.rules['no-test-mode-in-provider-runtime'],
);
protectedRuleLinter.defineRule(
  'local/no-uncontracted-api-routes',
  localPlugin.rules['no-uncontracted-api-routes'],
);
protectedRuleLinter.defineRule(
  'local/protected-rule-disable-policy',
  localPlugin.rules['protected-rule-disable-policy'],
);
protectedRuleLinter.defineRule('@typescript-eslint/no-restricted-imports', {
  meta: { type: 'problem', schema: [] },
  create: () => ({}),
});

function lintProtectedSource(source) {
  return protectedRuleLinter.verify(
    source,
    {
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
      rules: {
        'local/api-contract-builder-ownership': ['error', contractBuilderOwner],
        'local/api-contract-inspection-ownership': [
          'error',
          contractInspectionOwner,
        ],
        'local/environment-access-ownership': [
          'error',
          environmentAccessOptions,
        ],
        'local/workload-admission-write-ownership': [
          'error',
          workloadAdmissionWriteOwnershipOptions,
        ],
        'local/workload-event-metadata-ownership': 'error',
        'local/literal-module-loads': 'error',
        'local/no-barrel-reexports': 'error',
        'local/no-test-mode-in-provider-runtime': 'error',
        'local/no-uncontracted-api-routes': 'error',
        'local/protected-rule-disable-policy': ['error', { protectedRules }],
      },
    },
    'src/shared/api-contract/example.ts',
  );
}

function lintProtectedException(directive, statement, prelude = '') {
  return lintProtectedSource(`${prelude}${directive}\n${statement}`);
}

describe('protected ESLint rule exception policy', () => {
  it('accepts a justified builder-ownership next-line exception', () => {
    expect(
      lintProtectedException(
        '// eslint-disable-next-line local/api-contract-builder-ownership -- Compatibility fixture exercises a raw contract.',
        "contract.route({ method: 'GET', path: '/' });",
      ),
    ).toEqual([]);
  });

  it('accepts a justified inspection-ownership next-line exception', () => {
    expect(
      lintProtectedException(
        '// eslint-disable-next-line local/api-contract-inspection-ownership -- Compatibility fixture verifies legacy metadata.',
        "const metadata = procedure['~orpc'].meta;",
      ),
    ).toEqual([]);
  });

  it('preserves justified native-route next-line exceptions', () => {
    expect(
      lintProtectedException(
        '// eslint-disable-next-line local/no-uncontracted-api-routes -- Native byte stream owns backpressure.',
        "router.post('/items', handler);",
        "import { Router } from 'express';\nconst router = Router();\n",
      ),
    ).toEqual([]);
  });

  it('accepts a justified environment-ownership next-line exception', () => {
    expect(
      lintProtectedException(
        '// eslint-disable-next-line local/environment-access-ownership -- Native process bootstrap owns this one environment read.',
        'const value = process.env.BOOTSTRAP_VALUE;',
      ),
    ).toEqual([]);
  });

  it('requires a justification for provider test-mode exceptions', () => {
    expect(
      lintProtectedException(
        '// eslint-disable-next-line local/no-test-mode-in-provider-runtime',
        'const enabled = config.isTest;',
      ).map(({ messageId }) => messageId),
    ).toEqual(['reason']);
  });

  it('requires a justification for literal-module-load exceptions', () => {
    expect(
      lintProtectedSource(
        '// eslint-disable-next-line local/literal-module-loads\nconst mod = await import(modulePath);',
      ).map(({ messageId }) => messageId),
    ).toEqual(['reason']);
  });

  it('requires a justification for no-barrel exceptions', () => {
    expect(
      lintProtectedException(
        '// eslint-disable-next-line local/no-barrel-reexports',
        "export { value } from './owner.js';",
      ).map(({ messageId }) => messageId),
    ).toEqual(['reason']);
  });

  it('requires a justification for workload-admission write exceptions', () => {
    expect(
      lintProtectedException(
        '// eslint-disable-next-line local/workload-admission-write-ownership',
        'store.createWorkload(input);',
      ).map(({ messageId }) => messageId),
    ).toEqual(['reason']);
  });

  it('requires a justification for workload-event metadata exceptions', () => {
    expect(
      lintProtectedException(
        '// eslint-disable-next-line local/workload-event-metadata-ownership',
        "db.query('INSERT INTO workload_events (metadata) VALUES (?)', [raw]);",
      ).map(({ messageId }) => messageId),
    ).toEqual(['reason']);
  });

  it('requires a justification for production-to-harness import exceptions', () => {
    expect(
      lintProtectedException(
        '// eslint-disable-next-line no-restricted-imports',
        "import { helper } from '../../../test/helper.js';",
      ).map(({ messageId }) => messageId),
    ).toEqual(['reason']);
  });

  it('protects TypeScript-qualified import-rule exceptions', () => {
    expect(
      lintProtectedException(
        '// eslint-disable-next-line @typescript-eslint/no-restricted-imports',
        "import { ClientSecretCredential } from '@azure/identity';",
      ).map(({ messageId }) => messageId),
    ).toEqual(['reason']);
  });

  it('requires a justification for ownership exceptions', () => {
    expect(
      lintProtectedException(
        '// eslint-disable-next-line local/api-contract-builder-ownership',
        "contract.route({ method: 'GET', path: '/' });",
      ).map(({ messageId }) => messageId),
    ).toEqual(['reason']);
  });

  it('rejects file-wide ownership exceptions', () => {
    expect(
      lintProtectedSource(
        "/* eslint-disable local/api-contract-inspection-ownership -- Legacy metadata. */\nconst metadata = procedure['~orpc'].meta;",
      ).map(({ messageId }) => messageId),
    ).toEqual(['broad']);
  });

  it('rejects multi-rule ownership exceptions', () => {
    expect(
      lintProtectedException(
        '// eslint-disable-next-line local/api-contract-builder-ownership, local/api-contract-inspection-ownership -- Contract fixture.',
        "const metadata = procedure['~orpc'].meta;",
      ).map(({ messageId }) => messageId),
    ).toEqual(['broad']);
  });

  it('rejects same-line ownership exceptions', () => {
    expect(
      lintProtectedSource(
        "const metadata = procedure['~orpc'].meta; // eslint-disable-line local/api-contract-inspection-ownership -- Legacy metadata.",
      ).map(({ messageId }) => messageId),
    ).toEqual(['broad']);
  });

  it('rejects disable-all exceptions', () => {
    expect(
      lintProtectedException(
        '// eslint-disable-next-line -- Contract fixture.',
        "const metadata = procedure['~orpc'].meta;",
      ).map(({ messageId }) => messageId),
    ).toEqual(['broad']);
  });
});

describe('constrained E2E internal ESLint boundary coverage', () => {
  const eslint = new FlatESLint({ cwd: process.cwd() });

  it('enables the closed layer without inline configuration for canonical TypeScript', async () => {
    const config = await eslint.calculateConfigForFile(
      'test/integration/e2e/internal/contracts/config-fixture.ts',
    );

    expect(config?.rules?.['local/no-e2e-raw-mutation-clients']?.[0]).toBe(2);
    expect(config?.linterOptions?.noInlineConfig).toBe(true);
  });

  it.each([
    'test/integration/e2e/internal/contracts/config-fixture.mjs',
    'test/integration/e2e/internal/targets/config-fixture.mts',
  ])('rejects alternate module extension escapes in %s', async (filename) => {
    const [result] = await eslint.lintText(
      'import { execFile } from "node:child_process";',
      { filePath: filename },
    );
    const ruleIds = result.messages.map(({ ruleId }) => ruleId);

    expect(ruleIds).toContain('local/no-e2e-raw-mutation-clients');
    expect(ruleIds).toContain('no-restricted-syntax');
  });
});

describe('Local SmolVM ESLint boundary coverage', () => {
  const eslint = new FlatESLint({ cwd: process.cwd() });

  it.each([
    'src/api/services/gateways/local.ts',
    'scripts/ci/local-smolvm-runtime.ts',
    'scripts/ci/setup-local-smolvm-runtime.ts',
    'scripts/ci/cleanup-local-smolvm-runtime.ts',
    'test/integration/local-smolvm-runtime.spec.ts',
  ])('keeps graph-visible module loads enforced for %s', async (filename) => {
    const config = await eslint.calculateConfigForFile(filename);
    expect(config?.rules?.['local/literal-module-loads']?.[0]).toBe(2);
  });
});

describe.each([
  'src/cli/use-cases/save-credential.ts',
  'src/cli/renderers/quota-status.ts',
  'src/cli/renderers/workload-status.ts',
  'src/cli/use-cases/workload-list.ts',
])('CLI terminal-free ESLint boundary for %s', (filePath) => {
  const eslint = new FlatESLint({ cwd: process.cwd() });
  const restrictedRuleIds = async (source) => {
    const [result] = await eslint.lintText(source, { filePath });
    return result.messages
      .map(({ ruleId }) => ruleId)
      .filter((ruleId) =>
        [
          'no-console',
          'no-restricted-imports',
          'no-restricted-properties',
        ].includes(ruleId),
      );
  };

  it.each([
    ['process.exit(1);', 'no-restricted-properties'],
    ['process.exitCode = 1;', 'no-restricted-properties'],
    ["process.stdout.write('saved');", 'no-restricted-properties'],
    ["console.log('saved');", 'no-console'],
    ["import { exit } from 'node:process';", 'no-restricted-imports'],
    ["import process from 'process';", 'no-restricted-imports'],
  ])('rejects %s', async (source, ruleId) => {
    expect(await restrictedRuleIds(source)).toEqual([ruleId]);
  });

  it('allows returning a result', async () => {
    expect(
      await restrictedRuleIds(
        'export const exists = (names, name) => names.includes(name);',
      ),
    ).toEqual([]);
  });
});

describe('Azure generation transport ESLint boundary', () => {
  const eslint = new FlatESLint({ cwd: process.cwd() });
  const azureBootstrapFixture =
    'src/cli/services/credential-bootstrap/azure.ts';
  const otherCliFixture = 'src/cli/services/slurp/azure.ts';

  it('allows Azure generation to use only its semantic transport', async () => {
    const [result] = await eslint.lintText(
      "import { azureCliTransport } from './azure-transport.js';",
      { filePath: azureBootstrapFixture },
    );

    expect(
      result.messages.filter(
        ({ ruleId }) => ruleId === 'no-restricted-imports',
      ),
    ).toEqual([]);
  });

  it.each([
    "import { execFile } from 'child_process';",
    "import { spawn } from 'node:child_process';",
    "import { execAsync } from '../slurp/cli-exec.js';",
    "import { runAzureCli } from './azure-cli-runner.js';",
  ])(
    'rejects raw process execution from Azure generation: %s',
    async (source) => {
      const [result] = await eslint.lintText(source, {
        filePath: azureBootstrapFixture,
      });

      expect(result.messages.map(({ ruleId }) => ruleId)).toContain(
        'no-restricted-imports',
      );
    },
  );

  it.each([
    "import { ClientSecretCredential } from '@azure/identity';",
    "import { StorageManagementClient } from '@azure/arm-storage';",
    "import '@azure/core-rest-pipeline';",
  ])(
    'rejects Azure SDK runtime imports throughout the CLI: %s',
    async (source) => {
      for (const filePath of [azureBootstrapFixture, otherCliFixture]) {
        const [result] = await eslint.lintText(source, { filePath });

        expect(result.messages.map(({ ruleId }) => ruleId)).toContain(
          '@typescript-eslint/no-restricted-imports',
        );
      }
    },
  );

  it('allows Azure SDK type-only imports in the CLI', async () => {
    const [result] = await eslint.lintText(
      "import type { TokenCredential } from '@azure/identity';",
      { filePath: otherCliFixture },
    );

    expect(
      result.messages.filter(
        ({ ruleId }) => ruleId === '@typescript-eslint/no-restricted-imports',
      ),
    ).toEqual([]);
  });

  it.each(['mts', 'cts', 'tsx'])(
    'rejects Azure SDK runtime imports from CLI .%s sources',
    async (extension) => {
      const [result] = await eslint.lintText(
        "import { ClientSecretCredential } from '@azure/identity';",
        { filePath: `src/cli/services/slurp/azure.${extension}` },
      );

      expect(result.messages.map(({ ruleId }) => ruleId)).toContain(
        '@typescript-eslint/no-restricted-imports',
      );
    },
  );

  it('enforces explicit stored credentials in API provider clients', async () => {
    const config = await eslint.calculateConfigForFile(
      'src/api/services/gateways/aws.ts',
    );

    expect(
      config?.rules?.['local/explicit-api-provider-credentials']?.[0],
    ).toBe(2);
  });
});

describe('exact VM compute ESLint coverage', () => {
  const eslint = new FlatESLint({ cwd: process.cwd() });
  it.each([
    'src/api/services/monitor.ts',
    'src/api/services/conduct.ts',
    'src/api/services/node-pool-controller.ts',
    'src/api/services/cluster-installer-runtime.ts',
    'src/api/services/vm-runtime-storage.ts',
    'src/api/services/vm-compute.ts',
    'src/api/services/gateways/aws.ts',
    'src/cli/commands/cleanup.ts',
    'src/shared/compute.ts',
    'src/api/services/compute.mts',
    'src/api/services/compute.cts',
    'src/api/services/compute.tsx',
  ])('enables protected exact lifecycle ownership in %s', async (file) => {
    const config = await eslint.calculateConfigForFile(file);
    expect(config?.rules?.['local/exact-vm-compute-ownership']?.[0]).toBe(2);
  });
});

describe('workload-admission ESLint boundary coverage', () => {
  const eslint = new FlatESLint({ cwd: process.cwd() });

  it.each([
    'src/api/services/workload-admission-domain.ts',
    'src/api/services/workload-admission-resolution.ts',
    'src/api/services/workload-admission-plan.ts',
    'src/api/services/workload-admission-persistence.ts',
  ])('enables admission write ownership for %s', async (filename) => {
    const config = await eslint.calculateConfigForFile(filename);
    expect(
      config?.rules?.['local/workload-admission-write-ownership']?.[0],
    ).toBe(2);
  });
});

describe('repository-directory ESLint boundaries', () => {
  const eslint = new FlatESLint({ cwd: process.cwd() });

  it.each([
    'scripts/check-workspace-layout.mjs',
    'experiments/example/run.ts',
    'benchmarks/example.js',
  ])('lints %s', async (filename) => {
    expect(await eslint.isPathIgnored(filename)).toBe(false);
  });
});

describe('domain dependency ESLint boundaries', () => {
  const eslint = new FlatESLint({ cwd: process.cwd() });
  const linter = new Linter();
  const domainFixture = 'src/api/services/clusters-domain.ts';

  async function lintDomainSource(source) {
    const config = await eslint.calculateConfigForFile(domainFixture);
    const rule = config?.rules?.['no-restricted-imports'];
    expect(rule?.[0]).toBe(2);
    return linter.verify(
      source,
      {
        parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
        rules: { 'no-restricted-imports': rule },
      },
      domainFixture,
    );
  }

  it.each([
    "import { getPersistence } from './persistence.js';",
    "import { recordEvent } from './telemetry.js';",
    "import Aws from './gateways/aws.js';",
    "import { getDefaultServeRuntime } from './serve/default-runtime.js';",
  ])('rejects concrete domain infrastructure: %s', async (source) => {
    const messages = await lintDomainSource(source);

    expect(messages.map(({ ruleId }) => ruleId)).toContain(
      'no-restricted-imports',
    );
  });

  it('enables no-barrel enforcement for source modules', async () => {
    const config = await eslint.calculateConfigForFile('src/shared/example.ts');
    expect(config?.rules?.['local/no-barrel-reexports']?.[0]).toBe(2);
  });
});

describe('static source import ESLint configuration', () => {
  const eslint = new FlatESLint({ cwd: process.cwd() });
  const loadRuleIds = async (code, filePath) => {
    const [result] = await eslint.lintText(code, { filePath });
    return result.messages
      .map(({ ruleId }) => ruleId)
      .filter((ruleId) => ruleId === 'local/literal-module-loads');
  };

  it('rejects dynamic imports in every former allowlisted file', async () => {
    for (const filename of [
      'src/api/composition.ts',
      'src/api/services/cloud-config.ts',
      'src/api/services/repositories/db.ts',
      'src/shared/services/api-client/native.ts',
    ]) {
      expect(
        await loadRuleIds("await import('./sibling.js');", filename),
      ).toEqual(['local/literal-module-loads']);
    }
  });

  it('covers alternate TypeScript extensions', async () => {
    const config = await eslint.calculateConfigForFile('src/api/escape.mts');
    expect(config?.rules?.['local/literal-module-loads']?.[0]).toBe(2);
  });

  it('protects module loads and the eval family wherever the graph guard runs', async () => {
    for (const filename of [
      'src/api/services/api-health.ts',
      'src/api/widget.tsx',
      'src/api/escape.mjs',
      'scripts/check-workspace-layout.mjs',
      'scripts/ci/cleanup-local-smolvm-runtime.ts',
    ]) {
      const config = await eslint.calculateConfigForFile(filename);
      expect(config?.rules?.['local/literal-module-loads']?.[0]).toBe(2);
      expect(config?.rules?.['no-eval']?.[0]).toBe(2);
      expect(config?.rules?.['no-new-func']?.[0]).toBe(2);
    }
  });

  it('rejects a dynamic import in other source files', async () => {
    expect(
      await loadRuleIds(
        "await import('./persistence.js');",
        'src/api/services/api-health.ts',
      ),
    ).toEqual(['local/literal-module-loads']);
  });
});

describe('module graph boundary coverage', () => {
  const ruleSet = { forbidden: depcruiseConfig.forbidden };

  async function graphViolations(pathsToCruise, extraOptions = {}) {
    const result = await cruise(pathsToCruise, {
      ...depcruiseConfig.options,
      ruleSet,
      validate: true,
      ...extraOptions,
    });
    return result.output.summary.violations;
  }

  // Fixture worlds are built in a temp directory per test and never
  // committed: violating imports, trap names, and data: payloads are
  // exactly the content every other tool should never find in the tree.
  // The whole world is cruised so every recorded path is fixture-relative;
  // deps outside the cruised clusterRecords would otherwise render as climbing
  // paths.
  async function cruiseFixture(files) {
    // tmpdir() can be a symlink (macOS /var -> /private/var); baseDir
    // must be the real path or dependency-cruiser cannot relativize.
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'graph-fixture-')),
    );
    try {
      for (const [relativePath, content] of Object.entries(files)) {
        await mkdir(join(root, dirname(relativePath)), { recursive: true });
        await writeFile(join(root, relativePath), content);
      }
      const violations = await graphViolations(['.'], {
        baseDir: root,
        tsConfig: undefined,
      });
      return violations
        .map(
          (violation) =>
            `${violation.rule.name}: ${violation.from} -> ${violation.to}`,
        )
        .sort();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it(
    'keeps the real tree free of graph violations',
    { timeout: 120_000 },
    async () => {
      expect(
        await graphViolations([
          'src',
          'scripts',
          'test/integration/local-smolvm-runtime.spec.ts',
        ]),
      ).toEqual([]);
    },
  );

  // RFC 0028 invariant 11: the lint rule admits exactly the forms the
  // extractor records. A dependency-cruiser upgrade that changes extraction
  // semantics must fail here, not open a silent boundary hole.
  async function cruiseFixtureEdges(files) {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'graph-contract-')),
    );
    try {
      for (const [relativePath, content] of Object.entries(files)) {
        await mkdir(join(root, dirname(relativePath)), { recursive: true });
        await writeFile(join(root, relativePath), content);
      }
      const result = await cruise(['.'], {
        ...depcruiseConfig.options,
        tsConfig: undefined,
        baseDir: root,
      });
      const edges = [];
      for (const module of result.output.modules) {
        for (const dependency of module.dependencies) {
          edges.push({
            from: module.source,
            to: dependency.resolved ?? dependency.module,
            types: dependency.dependencyTypes,
          });
        }
      }
      return edges;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it('records an edge for every statically admitted form', async () => {
    const edges = await cruiseFixtureEdges({
      'src/forms.ts':
        "import './target.js';\n" +
        "import type { T } from './target.js';\n" +
        "export { value } from './target.js';\n" +
        "import 'some-package';\n" +
        "import 'node:fs';\n",
      'src/target.ts': 'export const value = 1;\nexport type T = number;\n',
    });
    const targets = edges
      .filter((edge) => edge.from === 'src/forms.ts')
      .map((edge) => edge.to)
      .sort();
    // node: prefixes resolve stripped, and the value and type-only
    // statements record as SEPARATE edges — the separation that keeps
    // `import type` immune to runtime-edge collapse.
    expect(targets).toEqual([
      'fs',
      'some-package',
      'src/target.ts',
      'src/target.ts',
    ]);
  });

  it('labels erased imports as pre-compilation-only and mixed imports as runtime', async () => {
    const edges = await cruiseFixtureEdges({
      'src/pure-type.ts':
        "import type { T } from './target.js';\nexport const t: T = 1;\n",
      'src/mixed.ts':
        "import dflt, { type T } from './target.js';\nconsole.log(dflt);\nexport const t: T = 1;\n",
      'src/target.ts':
        'const dflt = 1;\nexport default dflt;\nexport type T = number;\n',
    });
    const byFrom = new Map(edges.map((edge) => [edge.from, edge.types]));
    expect(byFrom.get('src/pure-type.ts')).toContain('pre-compilation-only');
    expect(byFrom.get('src/mixed.ts')).not.toContain('pre-compilation-only');
  });

  it('still records nothing for wrapped dynamic forms (upgrade canary)', async () => {
    const edges = await cruiseFixtureEdges({
      'src/wrapped.ts':
        'export async function load() {\n' +
        "  await import(('./target.js'));\n" +
        "  await import('./target.js' as string);\n" +
        '}\n',
      'src/target.ts': 'export const value = 1;\n',
    });
    expect(edges.filter((edge) => edge.from === 'src/wrapped.ts')).toEqual([]);
  });

  it('keeps production source out of tooling and harness directories', async () => {
    expect(
      await cruiseFixture({
        'src/shared/consumer.ts':
          "import '../../test/helper.js';\n" +
          "import '../../scripts/repository-tool.js';\n" +
          "import '../../ci/workflow-helper.js';\n" +
          "import '../../experiments/proof/run.js';\n" +
          "import '../../benchmarks/probe.js';\n",
        'test/helper.ts': 'export {};\n',
        'scripts/repository-tool.ts': 'export {};\n',
        'ci/workflow-helper.ts': 'export {};\n',
        'experiments/proof/run.ts': 'export {};\n',
        'benchmarks/probe.ts': 'export {};\n',
      }),
    ).toEqual([
      'production-source-boundary: src/shared/consumer.ts -> benchmarks/probe.ts',
      'production-source-boundary: src/shared/consumer.ts -> ci/workflow-helper.ts',
      'production-source-boundary: src/shared/consumer.ts -> experiments/proof/run.ts',
      'production-source-boundary: src/shared/consumer.ts -> scripts/repository-tool.ts',
      'production-source-boundary: src/shared/consumer.ts -> test/helper.ts',
    ]);
  });

  // Shipped artifacts carry dist/ (built from src/), node_modules and
  // package.json only, so a src/ import of any other repository file runs from
  // a checkout but crashes in the API image.
  it('keeps production source inside what the shipped artifacts carry', async () => {
    expect(
      await cruiseFixture({
        'src/cli/services/credential-bootstrap/aws.ts':
          "import '../../../../docs/reference/new-policy.json';\n" +
          "import '../../../../package.json';\n" +
          "import './sibling.js';\n",
        'src/cli/services/credential-bootstrap/sibling.ts': 'export {};\n',
        'docs/reference/new-policy.json': '{}\n',
        'package.json': '{}\n',
      }),
    ).toEqual([
      'production-source-boundary: src/cli/services/credential-bootstrap/aws.ts -> docs/reference/new-policy.json',
      'unexpected-root: src/cli/services/credential-bootstrap/aws.ts -> docs/reference/new-policy.json',
    ]);
  });

  it.each([
    ['scripts/tool.ts', 'test', 'script-boundary'],
    ['scripts/tool.ts', 'experiments', 'script-boundary'],
  ])('keeps %s out of %s code', async (source, target, boundary) => {
    expect(
      await cruiseFixture({
        [source]: `import '../${target}/helper.js';\n`,
        [`${target}/helper.js`]: 'export {};\n',
      }),
    ).toEqual([`${boundary}: ${source} -> ${target}/helper.js`]);
  });

  it('confines gateways to opaque resources', async () => {
    expect(
      await cruiseFixture({
        'src/api/services/gateways/aws.ts': "import '../cluster-store.js';\n",
        'src/api/services/cluster-store.ts': 'export {};\n',
      }),
    ).toEqual([
      'cloud-resource-boundary: src/api/services/gateways/aws.ts -> src/api/services/cluster-store.ts',
    ]);
  });

  it('keeps the substrate-neutral core out of kubernetes/ (RFC 0044 invariant 17)', async () => {
    expect(
      await cruiseFixture({
        'src/api/rpc/jobs.ts': "import '../services/kubernetes/client.js';\n",
        'src/api/services/repositories/workloads.ts':
          "import '../kubernetes/client.js';\n",
        'src/api/services/spend-controls-store.ts':
          "import './kubernetes/client.js';\n",
        'src/api/services/cluster-store.ts':
          "import './kubernetes/client.js';\n",
        'src/api/services/kubernetes/client.ts': 'export {};\n',
      }),
    ).toEqual([
      'substrate-neutral-core: src/api/rpc/jobs.ts -> src/api/services/kubernetes/client.ts',
      'substrate-neutral-core: src/api/services/repositories/workloads.ts -> src/api/services/kubernetes/client.ts',
      'substrate-neutral-core: src/api/services/spend-controls-store.ts -> src/api/services/kubernetes/client.ts',
    ]);
  });

  it('allows controllers to consume reconciliation mechanisms', async () => {
    expect(
      await cruiseFixture({
        'src/api/services/workload-reconciler.ts':
          "import './reconciliation/scheduler.js';\n",
        'src/api/services/reconciliation/scheduler.ts':
          "import './queue.js';\n",
        'src/api/services/reconciliation/queue.ts': 'export {};\n',
      }),
    ).toEqual([]);
  });

  it('keeps reconciliation mechanisms out of application stores', async () => {
    expect(
      await cruiseFixture({
        'src/api/services/reconciliation/scheduler.ts':
          "import '../deployment-store.js';\n",
        'src/api/services/deployment-store.ts': 'export {};\n',
      }),
    ).toEqual([
      'reconciliation-mechanism-boundary: src/api/services/reconciliation/scheduler.ts -> src/api/services/deployment-store.ts',
    ]);
  });

  it('rejects type-only domain imports in reconciliation mechanisms', async () => {
    expect(
      await cruiseFixture({
        'src/api/services/reconciliation/scheduler.ts':
          "import type { WorkloadState } from '../../../shared/workload.js';\n" +
          'export type ScheduledState = WorkloadState;\n',
        'src/shared/workload.ts': "export type WorkloadState = 'Running';\n",
      }),
    ).toEqual([
      'reconciliation-mechanism-boundary: src/api/services/reconciliation/scheduler.ts -> src/shared/workload.ts',
    ]);
  });

  it('keeps the smolvm contract dependency-free', async () => {
    expect(
      await cruiseFixture({
        'src/api/services/gateways/local-smolvm-contract.ts':
          "import '../../../shared/contract-helper.js';\n",
        'src/shared/contract-helper.ts': 'export {};\n',
      }),
    ).toEqual([
      'smolvm-contract-dependency-free: src/api/services/gateways/local-smolvm-contract.ts -> src/shared/contract-helper.ts',
    ]);
  });

  it('restricts raw database access to runtime consumers only', async () => {
    const db =
      'const dbDefault = 1;\nexport default dbDefault;\nexport const db = 1;\nexport type Db = number;\n';
    expect(
      await cruiseFixture({
        'src/api/services/repositories/db.ts': db,
        'src/api/value-consumer.ts':
          "import { db } from './services/repositories/db.js';\nconsole.log(db);\n",
        'src/api/mixed-consumer.ts':
          "export type T = import('./services/repositories/db.js').Db;\n" +
          "import { db } from './services/repositories/db.js';\nconsole.log(db);\n",
        'src/api/mixed-default-consumer.ts':
          "import dbDefault, { type Db } from './services/repositories/db.js';\nconsole.log(dbDefault);\nexport const t: Db = 1;\n",
        'src/api/type-consumer.ts':
          "import type { Db } from './services/repositories/db.js';\nconst answer: Db = 1;\nconsole.log(answer);\n",
        'src/api/type-expression-consumer.ts':
          "export type T = import('./services/repositories/db.js').Db;\nexport const marker: T = 1;\n",
      }),
    ).toEqual([
      'raw-db-access: src/api/mixed-consumer.ts -> src/api/services/repositories/db.ts',
      'raw-db-access: src/api/mixed-default-consumer.ts -> src/api/services/repositories/db.ts',
      'raw-db-access: src/api/value-consumer.ts -> src/api/services/repositories/db.ts',
    ]);
  });

  it('holds module ownership for the smolvm runtime', async () => {
    expect(
      await cruiseFixture({
        'src/api/services/gateways/local-smolvm-runtime.ts': 'export {};\n',
        'src/api/services/gateways/local.ts':
          "import './local-smolvm-runtime.js';\n",
        'src/api/outsider.ts':
          "import './services/gateways/local-smolvm-runtime.js';\n",
      }),
    ).toEqual([
      'module-ownership:gateways.local-smolvm-runtime.ts: src/api/outsider.ts -> src/api/services/gateways/local-smolvm-runtime.ts',
    ]);
  });

  it('schedules extracted background monitors only from monitor composition', async () => {
    expect(
      await cruiseFixture({
        'src/api/services/notifications-digest.ts': 'export {};\n',
        'src/api/services/cost-calculation/monitor.ts': 'export {};\n',
        'src/api/services/monitor.ts':
          "import './notifications-digest.js';\nimport './cost-calculation/monitor.js';\n",
        'src/api/server.ts':
          "import './services/notifications-digest.js';\nimport './services/cost-calculation/monitor.js';\n",
      }),
    ).toEqual([
      'module-ownership:cost-calculation.monitor.ts: src/api/server.ts -> src/api/services/cost-calculation/monitor.ts',
      'module-ownership:services.notifications-digest.ts: src/api/server.ts -> src/api/services/notifications-digest.ts',
    ]);
  });

  it('holds module ownership for credential onboarding', async () => {
    expect(
      await cruiseFixture({
        'src/cli/services/credential-onboarding/acquisition.ts': 'export {};\n',
        'src/cli/services/credential-onboarding/index.ts':
          "import './acquisition.js';\n",
        'src/cli/commands/credentials/new.ts':
          "import '../../services/credential-onboarding/acquisition.js';\n",
      }),
    ).toEqual([
      'module-ownership:credential-onboarding.acquisition.ts: src/cli/commands/credentials/new.ts -> src/cli/services/credential-onboarding/acquisition.ts',
    ]);
  });

  it('keeps CLI use cases free of terminal I/O and owned by their command', async () => {
    expect(
      await cruiseFixture({
        'src/cli/use-cases/save-credential.ts':
          "import '../services/api.js';\n" +
          "import '../utils/output.js';\n" +
          "import '../utils/safe-prompts.js';\n" +
          "import '../prompts/name.js';\n" +
          "import '../renderers/table.js';\n" +
          "import '../commands/credentials/list.js';\n" +
          "import 'ora';\n" +
          "import 'chalk';\n" +
          "import 'prompts';\n" +
          "import 'cli-table3';\n",
        'src/cli/services/api.ts': 'export {};\n',
        'src/cli/utils/output.ts': 'export {};\n',
        'src/cli/utils/safe-prompts.ts': 'export {};\n',
        'src/cli/prompts/name.ts': 'export {};\n',
        'src/cli/renderers/table.ts': 'export {};\n',
        'src/cli/commands/credentials/list.ts': 'export {};\n',
        ...Object.fromEntries(
          ['ora', 'chalk', 'prompts', 'cli-table3'].flatMap((name) => [
            [`node_modules/${name}/package.json`, '{"main": "index.js"}\n'],
            [`node_modules/${name}/index.js`, 'export {};\n'],
          ]),
        ),
        'src/cli/commands/credentials/new.ts':
          "import '../../use-cases/save-credential.js';\n",
        'src/cli/commands/credentials/edit.ts':
          "import '../../use-cases/save-credential.js';\n",
      }),
    ).toEqual([
      'cli-use-case-boundary: src/cli/use-cases/save-credential.ts -> node_modules/chalk/index.js',
      'cli-use-case-boundary: src/cli/use-cases/save-credential.ts -> node_modules/cli-table3/index.js',
      'cli-use-case-boundary: src/cli/use-cases/save-credential.ts -> node_modules/ora/index.js',
      'cli-use-case-boundary: src/cli/use-cases/save-credential.ts -> node_modules/prompts/index.js',
      'cli-use-case-boundary: src/cli/use-cases/save-credential.ts -> src/cli/commands/credentials/list.ts',
      'cli-use-case-boundary: src/cli/use-cases/save-credential.ts -> src/cli/prompts/name.ts',
      'cli-use-case-boundary: src/cli/use-cases/save-credential.ts -> src/cli/renderers/table.ts',
      'cli-use-case-boundary: src/cli/use-cases/save-credential.ts -> src/cli/utils/output.ts',
      'cli-use-case-boundary: src/cli/use-cases/save-credential.ts -> src/cli/utils/safe-prompts.ts',
      'module-ownership:use-cases.save-credential.ts: src/cli/commands/credentials/edit.ts -> src/cli/use-cases/save-credential.ts',
      ...['cli-table3', 'ora', 'prompts'].map(
        (name) =>
          `terminal-library-ownership:${name}: src/cli/use-cases/save-credential.ts -> node_modules/${name}/index.js`,
      ),
    ]);
  });

  it('lets only each terminal library wrapper import its library', async () => {
    expect(
      await cruiseFixture({
        'src/cli/renderers/table.ts': "import 'cli-table3';\n",
        'src/cli/utils/output.ts': "import 'ora';\n",
        'src/cli/utils/safe-prompts.ts': "import 'prompts';\n",
        'src/cli/commands/images.ts': "import 'cli-table3';\n",
      }),
    ).toEqual([
      'terminal-library-ownership:cli-table3: src/cli/commands/images.ts -> cli-table3',
    ]);
  });

  it('keeps CLI renderers and prompts off I/O they do not own, and owned by their command', async () => {
    expect(
      await cruiseFixture({
        'src/cli/renderers/quota-status.ts':
          "import '../use-cases/quota-status.js';\n" +
          "import '../services/api.js';\n" +
          "import '../utils/output.js';\n" +
          "import '../prompts/quota-types.js';\n" +
          "import '../../shared/services/api-client/rpc.js';\n",
        'src/cli/prompts/quota-types.ts':
          "import '../utils/safe-prompts.js';\n" +
          "import '../utils/output.js';\n" +
          "import '../renderers/quota-status.js';\n" +
          "import '../use-cases/quota-status.js';\n",
        'src/cli/use-cases/quota-status.ts': 'export {};\n',
        'src/cli/services/api.ts': 'export {};\n',
        'src/cli/utils/output.ts': 'export {};\n',
        'src/cli/utils/safe-prompts.ts': 'export {};\n',
        'src/shared/services/api-client/rpc.ts': 'export {};\n',
        'src/cli/commands/quota.ts':
          "import '../renderers/quota-status.js';\n" +
          "import '../prompts/quota-types.js';\n" +
          "import '../use-cases/quota-status.js';\n",
        'src/cli/commands/status.ts':
          "import '../renderers/quota-status.js';\n",
      }),
    ).toEqual([
      'cli-prompt-boundary: src/cli/prompts/quota-types.ts -> src/cli/renderers/quota-status.ts',
      'cli-prompt-boundary: src/cli/prompts/quota-types.ts -> src/cli/use-cases/quota-status.ts',
      'cli-prompt-boundary: src/cli/prompts/quota-types.ts -> src/cli/utils/output.ts',
      'cli-renderer-boundary: src/cli/renderers/quota-status.ts -> src/cli/prompts/quota-types.ts',
      'cli-renderer-boundary: src/cli/renderers/quota-status.ts -> src/cli/services/api.ts',
      'cli-renderer-boundary: src/cli/renderers/quota-status.ts -> src/cli/utils/output.ts',
      'cli-renderer-boundary: src/cli/renderers/quota-status.ts -> src/shared/services/api-client/rpc.ts',
      'module-ownership:prompts.quota-types.ts: src/cli/renderers/quota-status.ts -> src/cli/prompts/quota-types.ts',
      'module-ownership:renderers.quota-status.ts: src/cli/commands/status.ts -> src/cli/renderers/quota-status.ts',
      'module-ownership:renderers.quota-status.ts: src/cli/prompts/quota-types.ts -> src/cli/renderers/quota-status.ts',
      'module-ownership:use-cases.quota-status.ts: src/cli/prompts/quota-types.ts -> src/cli/use-cases/quota-status.ts',
    ]);
  });

  it('keeps workload status and list owned by their commands and off terminal I/O', async () => {
    expect(
      await cruiseFixture({
        'src/cli/renderers/workload-status.ts':
          "import type { T } from '../use-cases/workload-status.js';\n" +
          "import '../../shared/services/api-client/rpc.js';\n",
        'src/cli/use-cases/workload-status.ts': 'export {};\n',
        'src/shared/services/api-client/rpc.ts': 'export {};\n',
        'src/cli/utils/output.ts': 'export {};\n',
        'src/cli/prompts/workload-list.ts':
          "import '../use-cases/workload-list.js';\n" +
          "import '../utils/output.js';\n",
        'src/cli/renderers/workload-list.ts':
          "import '../use-cases/workload-list.js';\n",
        'src/cli/use-cases/workload-list.ts': "import 'cli-table3';\n",
        'src/cli/commands/status.ts':
          "import '../renderers/workload-status.js';\n" +
          "import '../use-cases/workload-status.js';\n" +
          "import '../prompts/workload-list.js';\n" +
          "import '../renderers/workload-list.js';\n",
        'src/cli/commands/list.ts':
          "import '../renderers/workload-status.js';\n" +
          "import '../use-cases/workload-status.js';\n" +
          "import '../prompts/workload-list.js';\n" +
          "import '../renderers/workload-list.js';\n" +
          "import '../use-cases/workload-list.js';\n",
      }),
    ).toEqual([
      'cli-prompt-boundary: src/cli/prompts/workload-list.ts -> src/cli/use-cases/workload-list.ts',
      'cli-prompt-boundary: src/cli/prompts/workload-list.ts -> src/cli/utils/output.ts',
      'cli-renderer-boundary: src/cli/renderers/workload-status.ts -> src/shared/services/api-client/rpc.ts',
      'cli-use-case-boundary: src/cli/use-cases/workload-list.ts -> cli-table3',
      'module-ownership:prompts.workload-list.ts: src/cli/commands/status.ts -> src/cli/prompts/workload-list.ts',
      'module-ownership:renderers.workload-list.ts: src/cli/commands/status.ts -> src/cli/renderers/workload-list.ts',
      'module-ownership:renderers.workload-status.ts: src/cli/commands/list.ts -> src/cli/renderers/workload-status.ts',
      'module-ownership:use-cases.workload-list.ts: src/cli/prompts/workload-list.ts -> src/cli/use-cases/workload-list.ts',
      'module-ownership:use-cases.workload-status.ts: src/cli/commands/list.ts -> src/cli/use-cases/workload-status.ts',
      'terminal-library-ownership:cli-table3: src/cli/use-cases/workload-list.ts -> cli-table3',
    ]);
  });

  it('keeps the workload lifecycle writer behind persistence and its type consumers', async () => {
    expect(
      await cruiseFixture({
        'src/api/services/repositories/workload-lifecycle.ts': 'export {};\n',
        'src/api/services/persistence.ts':
          "import './repositories/workload-lifecycle.js';\n",
        'src/api/services/repositories/workload-outcomes.ts':
          "import './workload-lifecycle.js';\n",
        'src/api/services/repositories/workload-queries.ts':
          "import './workload-lifecycle.js';\n",
        'src/api/services/workload-workflows/retry-recovery.ts':
          "import type { T } from '../repositories/workload-lifecycle.js';\n",
        'src/api/services/workload-reconciler.ts':
          "import type { T } from './repositories/workload-lifecycle.js';\n",
        'src/api/services/serve/runtime.ts':
          "import '../repositories/workload-lifecycle.js';\n",
        'src/api/services/monitor.ts':
          "import './repositories/workload-lifecycle.js';\n",
        'src/api/services/conduct.ts':
          "import './repositories/workload-lifecycle.js';\n",
        'src/api/services/workload-cleanup.ts':
          "import './repositories/workload-lifecycle.js';\n",
      }),
    ).toEqual([
      'module-ownership:repositories.workload-lifecycle.ts: src/api/services/conduct.ts -> src/api/services/repositories/workload-lifecycle.ts',
      'module-ownership:repositories.workload-lifecycle.ts: src/api/services/monitor.ts -> src/api/services/repositories/workload-lifecycle.ts',
      'module-ownership:repositories.workload-lifecycle.ts: src/api/services/repositories/workload-queries.ts -> src/api/services/repositories/workload-lifecycle.ts',
      'module-ownership:repositories.workload-lifecycle.ts: src/api/services/workload-cleanup.ts -> src/api/services/repositories/workload-lifecycle.ts',
      'module-ownership:repositories.workload-lifecycle.ts:types: src/api/services/serve/runtime.ts -> src/api/services/repositories/workload-lifecycle.ts',
    ]);
  });

  it('keeps the workload outcome writer behind persistence and its sibling repositories', async () => {
    expect(
      await cruiseFixture({
        'src/api/services/repositories/workload-outcomes.ts': 'export {};\n',
        'src/api/services/persistence.ts':
          "import './repositories/workload-outcomes.js';\n",
        'src/api/services/repositories/workload-queries.ts':
          "import './workload-outcomes.js';\n",
        'src/api/services/workload-cleanup.ts':
          "import './repositories/workload-outcomes.js';\n",
        'src/api/services/workload-workflows/cleanup.ts':
          "import type { T } from '../repositories/workload-outcomes.js';\n",
      }),
    ).toEqual([
      'module-ownership:repositories.workload-outcomes.ts: src/api/services/workload-cleanup.ts -> src/api/services/repositories/workload-outcomes.ts',
      'module-ownership:repositories.workload-outcomes.ts: src/api/services/workload-workflows/cleanup.ts -> src/api/services/repositories/workload-outcomes.ts',
    ]);
  });

  it('keeps the digest formatter behind the digest', async () => {
    expect(
      await cruiseFixture({
        'src/api/services/notifications-digest-format.ts': 'export {};\n',
        'src/api/services/notifications-digest.ts':
          "import './notifications-digest-format.js';\n",
        'src/api/services/monitor.ts':
          "import './notifications-digest-format.js';\n",
      }),
    ).toEqual([
      'module-ownership:services.notifications-digest-format.ts: src/api/services/monitor.ts -> src/api/services/notifications-digest-format.ts',
    ]);
  });

  it('keeps the attempt ledger and workload events behind persistence and their named type consumers', async () => {
    expect(
      await cruiseFixture({
        'src/api/services/repositories/provisioning-attempts.ts':
          'export {};\n',
        'src/api/services/repositories/workload-events.ts': 'export {};\n',
        'src/api/services/persistence.ts':
          "import './repositories/provisioning-attempts.js';\n" +
          "import './repositories/workload-events.js';\n",
        'src/api/services/repositories/workload-queries.ts':
          "import type { T } from './provisioning-attempts.js';\n" +
          "import type { U } from './workload-events.js';\n",
        'src/api/services/monitor.ts':
          "import './repositories/provisioning-attempts.js';\n" +
          "import './repositories/workload-events.js';\n",
        'src/api/services/vm-release-notifications.ts':
          "import type { T } from './repositories/provisioning-attempts.js';\n",
        'src/api/composition.ts':
          "import './services/repositories/workload-events.js';\n",
        'src/api/services/workload-management-domain.ts':
          "import './repositories/workload-events.js';\n",
        'src/api/services/conduct.ts':
          "import './repositories/provisioning-attempts.js';\n" +
          "import './repositories/workload-events.js';\n",
        'src/api/services/vm-provisioner.ts':
          "import './repositories/provisioning-attempts.js';\n",
        'src/api/services/workload-workflows/workload-pipeline.ts':
          "import type { T } from '../repositories/provisioning-attempts.js';\n",
      }),
    ).toEqual([
      'module-ownership:repositories.provisioning-attempts.ts: src/api/services/conduct.ts -> src/api/services/repositories/provisioning-attempts.ts',
      'module-ownership:repositories.provisioning-attempts.ts: src/api/services/monitor.ts -> src/api/services/repositories/provisioning-attempts.ts',
      'module-ownership:repositories.provisioning-attempts.ts: src/api/services/vm-provisioner.ts -> src/api/services/repositories/provisioning-attempts.ts',
      'module-ownership:repositories.workload-events.ts: src/api/services/conduct.ts -> src/api/services/repositories/workload-events.ts',
      'module-ownership:repositories.workload-events.ts: src/api/services/monitor.ts -> src/api/services/repositories/workload-events.ts',
      'module-ownership:repositories.workload-events.ts:types: src/api/services/workload-management-domain.ts -> src/api/services/repositories/workload-events.ts',
    ]);
  });

  it('keeps credentials and secrets behind persistence and the admission writer', async () => {
    const importOwner = "import './repositories/credential-secrets.js';\n";
    expect(
      await cruiseFixture({
        'src/api/services/repositories/credential-secrets.ts': 'export {};\n',
        'src/api/services/persistence.ts': importOwner,
        'src/api/services/workload-admission-writer.ts': importOwner,
        'src/api/services/credentials-domain.ts': importOwner,
        'src/api/composition.ts':
          "import './services/repositories/credential-secrets.js';\n",
      }),
    ).toEqual([
      'module-ownership:repositories.credential-secrets.ts: src/api/composition.ts -> src/api/services/repositories/credential-secrets.ts',
      'module-ownership:repositories.credential-secrets.ts: src/api/services/credentials-domain.ts -> src/api/services/repositories/credential-secrets.ts',
    ]);
  });

  it('keeps Workload queries behind persistence and their exact type importers', async () => {
    const importOwner = "import './repositories/workload-queries.js';\n";
    expect(
      await cruiseFixture({
        'src/api/services/repositories/workload-queries.ts': 'export {};\n',
        'src/api/services/persistence.ts': importOwner,
        'src/api/services/repositories/workload-spend.ts':
          "import './workload-queries.js';\n",
        'src/api/services/notifications-digest.ts': importOwner,
        'src/api/services/workload-management-domain.ts':
          "import type { T } from './repositories/workload-queries.js';\n",
        'src/api/services/workload-reconciler.ts': importOwner,
        'src/api/services/monitor.ts': importOwner,
        'src/api/composition.ts':
          "import './services/repositories/workload-queries.js';\n",
      }),
    ).toEqual([
      'module-ownership:repositories.workload-queries.ts: src/api/composition.ts -> src/api/services/repositories/workload-queries.ts',
      'module-ownership:repositories.workload-queries.ts: src/api/services/monitor.ts -> src/api/services/repositories/workload-queries.ts',
      'module-ownership:repositories.workload-queries.ts: src/api/services/notifications-digest.ts -> src/api/services/repositories/workload-queries.ts',
      'module-ownership:repositories.workload-queries.ts:types: src/api/services/workload-reconciler.ts -> src/api/services/repositories/workload-queries.ts',
    ]);
  });

  it('keeps Workload spend reads behind persistence and the digest', async () => {
    const importOwner = "import './repositories/workload-spend.js';\n";
    expect(
      await cruiseFixture({
        'src/api/services/repositories/workload-spend.ts': 'export {};\n',
        'src/api/services/persistence.ts': importOwner,
        'src/api/services/notifications-digest.ts': importOwner,
        'src/api/services/workload-management-domain.ts': importOwner,
        'src/api/services/monitor.ts': importOwner,
      }),
    ).toEqual([
      'module-ownership:repositories.workload-spend.ts: src/api/services/monitor.ts -> src/api/services/repositories/workload-spend.ts',
      'module-ownership:repositories.workload-spend.ts: src/api/services/workload-management-domain.ts -> src/api/services/repositories/workload-spend.ts',
    ]);
  });

  it('keeps Workload creation behind the admission writer, and its consumers on types', async () => {
    const importOwner = "import './repositories/workload-creation.js';\n";
    const importTypes =
      "import type { T } from './repositories/workload-creation.js';\n";
    expect(
      await cruiseFixture({
        'src/api/services/repositories/workload-creation.ts': 'export {};\n',
        'src/api/services/workload-admission-writer.ts': importOwner,
        'src/api/services/workload-admission-plan.ts': importTypes,
        'src/api/services/workload-admission-persistence.ts': importOwner,
        'src/api/services/persistence.ts': importOwner,
        'src/api/services/repositories/workload-lifecycle.ts':
          "import './workload-creation.js';\n",
      }),
    ).toEqual([
      'module-ownership:repositories.workload-creation.ts: src/api/services/persistence.ts -> src/api/services/repositories/workload-creation.ts',
      'module-ownership:repositories.workload-creation.ts: src/api/services/repositories/workload-lifecycle.ts -> src/api/services/repositories/workload-creation.ts',
      'module-ownership:repositories.workload-creation.ts:types: src/api/services/workload-admission-persistence.ts -> src/api/services/repositories/workload-creation.ts',
    ]);
  });

  it('lets only monitor composition import the retry workflow, and only it and the workflow import the release observer', async () => {
    expect(
      await cruiseFixture({
        'src/api/services/workload-workflows/retry-recovery.ts':
          "import '../host-runtime/vm-release-observer.js';\n",
        'src/api/services/host-runtime/vm-release-observer.ts': 'export {};\n',
        'src/api/services/monitor.ts':
          "import './workload-workflows/retry-recovery.js';\nimport './host-runtime/vm-release-observer.js';\n",
        'src/api/services/conduct.ts':
          "import './workload-workflows/retry-recovery.js';\nimport './host-runtime/vm-release-observer.js';\n",
      }),
    ).toEqual([
      'module-ownership:host-runtime.vm-release-observer.ts: src/api/services/conduct.ts -> src/api/services/host-runtime/vm-release-observer.ts',
      'module-ownership:workload-workflows.retry-recovery.ts: src/api/services/conduct.ts -> src/api/services/workload-workflows/retry-recovery.ts',
    ]);
  });

  it('lets only monitor composition import the cleanup workflow, and only the named runtimes import termination', async () => {
    expect(
      await cruiseFixture({
        'src/api/services/workload-workflows/cleanup.ts': 'export {};\n',
        'src/api/services/host-runtime/termination.ts': 'export {};\n',
        'src/api/services/monitor.ts':
          "import './workload-workflows/cleanup.js';\n",
        'src/api/services/conduct.ts':
          "import './workload-workflows/cleanup.js';\nimport './host-runtime/termination.js';\n",
        'src/api/services/job/default-runtime.ts':
          "import '../host-runtime/termination.js';\n",
        'src/api/services/serve/default-runtime.ts':
          "import '../host-runtime/termination.js';\n",
        'src/api/services/workload-workflows/retry-recovery.ts':
          "import '../host-runtime/termination.js';\n",
        'src/api/services/node-pool-controller.ts':
          "import './host-runtime/termination.js';\n",
      }),
    ).toEqual([
      'module-ownership:host-runtime.termination.ts: src/api/services/conduct.ts -> src/api/services/host-runtime/termination.ts',
      'module-ownership:host-runtime.termination.ts: src/api/services/node-pool-controller.ts -> src/api/services/host-runtime/termination.ts',
      'module-ownership:workload-workflows.cleanup.ts: src/api/services/conduct.ts -> src/api/services/workload-workflows/cleanup.ts',
    ]);
  });

  it('lets only the runtimes and monitor import VM-host startup, and only startup and VM repair import its host effects', async () => {
    expect(
      await cruiseFixture({
        'src/api/services/workload-workflows/vm-host-startup.ts':
          "import '../host-runtime/host-startup.js';\n",
        'src/api/services/host-runtime/host-startup.ts':
          "import './image-delivery.js';\n",
        'src/api/services/host-runtime/image-delivery.ts': 'export {};\n',
        'src/api/services/job/default-runtime.ts':
          "import '../workload-workflows/vm-host-startup.js';\n",
        'src/api/services/serve/default-runtime.ts':
          "import '../workload-workflows/vm-host-startup.js';\n",
        'src/api/services/monitor.ts':
          "import './workload-workflows/vm-host-startup.js';\n",
        'src/api/services/host-runtime/vm-container-repair.ts':
          "import './host-startup.js';\nimport './image-delivery.js';\n",
        'src/api/services/conduct.ts':
          "import './workload-workflows/vm-host-startup.js';\n",
        'src/api/services/workload-workflows/retry-recovery.ts':
          "import './vm-host-startup.js';\n",
        'src/api/services/docker.ts':
          "import './host-runtime/host-startup.js';\nimport './host-runtime/image-delivery.js';\n",
      }),
    ).toEqual([
      'module-ownership:host-runtime.host-startup.ts: src/api/services/docker.ts -> src/api/services/host-runtime/host-startup.ts',
      'module-ownership:host-runtime.image-delivery.ts: src/api/services/docker.ts -> src/api/services/host-runtime/image-delivery.ts',
      'module-ownership:workload-workflows.vm-host-startup.ts: src/api/services/conduct.ts -> src/api/services/workload-workflows/vm-host-startup.ts',
      'module-ownership:workload-workflows.vm-host-startup.ts: src/api/services/workload-workflows/retry-recovery.ts -> src/api/services/workload-workflows/vm-host-startup.ts',
    ]);
  });

  it('lets only monitor composition import VM repair and dispatch, and only their named consumers import the repair effect, pipeline, auth policy and admission checks', async () => {
    expect(
      await cruiseFixture({
        'src/api/services/workload-workflows/persistent-vm-repair.ts':
          "import '../host-runtime/vm-container-repair.js';\n",
        'src/api/services/host-runtime/vm-container-repair.ts': 'export {};\n',
        'src/api/services/workload-workflows/workload-pipeline.ts':
          'export {};\n',
        'src/api/services/workload-workflows/provisioning-scheduler.ts':
          "import './workload-pipeline.js';\n",
        'src/api/services/monitor.ts': [
          "import './workload-workflows/persistent-vm-repair.js';",
          "import './workload-workflows/workload-pipeline.js';",
          "import './workload-workflows/provisioning-scheduler.js';",
          '',
        ].join('\n'),
        'src/api/services/credential-auth-failure.ts': 'export {};\n',
        'src/api/services/launch-targets.ts':
          "import './credential-auth-failure.js';\n",
        'src/api/services/workload-admission-checks.ts': 'export {};\n',
        'src/api/composition.ts':
          "import './services/workload-admission-checks.js';\n",
        'src/api/services/compute-validation.ts':
          "import './workload-admission-checks.js';\n",
        'src/api/services/workload-admission-plan.ts':
          "import './workload-admission-checks.js';\n",
        'src/api/services/workload-workflows/retry-recovery.ts': [
          "import '../host-runtime/vm-container-repair.js';",
          "import './persistent-vm-repair.js';",
          "import './workload-pipeline.js';",
          "import './provisioning-scheduler.js';",
          "import '../credential-auth-failure.js';",
          "import '../workload-admission-checks.js';",
          '',
        ].join('\n'),
      }),
    ).toEqual([
      'module-ownership:host-runtime.vm-container-repair.ts: src/api/services/workload-workflows/retry-recovery.ts -> src/api/services/host-runtime/vm-container-repair.ts',
      'module-ownership:services.credential-auth-failure.ts: src/api/services/workload-workflows/retry-recovery.ts -> src/api/services/credential-auth-failure.ts',
      'module-ownership:services.workload-admission-checks.ts: src/api/services/workload-workflows/retry-recovery.ts -> src/api/services/workload-admission-checks.ts',
      'module-ownership:workload-workflows.persistent-vm-repair.ts: src/api/services/workload-workflows/retry-recovery.ts -> src/api/services/workload-workflows/persistent-vm-repair.ts',
      'module-ownership:workload-workflows.provisioning-scheduler.ts: src/api/services/workload-workflows/retry-recovery.ts -> src/api/services/workload-workflows/provisioning-scheduler.ts',
      'module-ownership:workload-workflows.workload-pipeline.ts: src/api/services/workload-workflows/retry-recovery.ts -> src/api/services/workload-workflows/workload-pipeline.ts',
    ]);
  });

  it('lets only the Job runtime and the completion handlers import completion, and only monitor composition import the handlers', async () => {
    expect(
      await cruiseFixture({
        'src/api/services/workload-workflows/completion.ts': 'export {};\n',
        'src/api/services/workload-workflows/completion-reconcile.ts':
          "import './completion.js';\nimport './retry-recovery.js';\nimport '../host-runtime/vm-release-observer.js';\n",
        'src/api/services/workload-workflows/retry-recovery.ts': 'export {};\n',
        'src/api/services/host-runtime/vm-release-observer.ts': 'export {};\n',
        'src/api/services/job/default-runtime.ts':
          "import '../workload-workflows/completion.js';\n",
        'src/api/services/monitor.ts':
          "import './workload-workflows/completion-reconcile.js';\nimport './workload-workflows/retry-recovery.js';\n",
        'src/api/services/conduct.ts':
          "import './workload-workflows/completion.js';\nimport './workload-workflows/completion-reconcile.js';\n",
      }),
    ).toEqual([
      'module-ownership:workload-workflows.completion-reconcile.ts: src/api/services/conduct.ts -> src/api/services/workload-workflows/completion-reconcile.ts',
      'module-ownership:workload-workflows.completion.ts: src/api/services/conduct.ts -> src/api/services/workload-workflows/completion.ts',
    ]);
  });

  it('keeps workload workflows off composition, stores, and provider code, and effects off workflows', async () => {
    expect(
      await cruiseFixture({
        'src/api/services/workload-workflows/retry-recovery.ts': [
          "import '../gateways/cloud.js';",
          "import '../conduct.js';",
          "import '../monitor.js';",
          "import '../persistence.js';",
          "import '../gateways/aws.js';",
          "import '../provider-clients/aws.js';",
          "import '@aws-sdk/client-ec2';",
          "import type { Db } from '../repositories/db.js';",
          "import 'better-sqlite3';",
          'export {};',
          '',
        ].join('\n'),
        'src/api/services/gateways/cloud.ts': 'export {};\n',
        'src/api/services/gateways/aws.ts': 'export {};\n',
        'src/api/services/provider-clients/aws.ts': 'export {};\n',
        'src/api/services/conduct.ts': 'export {};\n',
        'src/api/services/repositories/db.ts': 'export type Db = 1;\n',
        'src/api/services/persistence.ts': 'export {};\n',
        'src/api/services/monitor.ts':
          "import './workload-workflows/retry-recovery.js';\nimport './host-runtime/vm-release-observer.js';\n",
        'src/api/services/host-runtime/vm-release-observer.ts':
          "import '../gateways/cloud.js';\nimport '../workload-workflows/retry-recovery.js';\nimport '../monitor.js';\n",
        'src/api/services/repositories/workload-lifecycle.ts':
          "import '../workload-workflows/retry-recovery.js';\n",
      }),
    ).toEqual([
      'module-ownership:workload-workflows.retry-recovery.ts: src/api/services/host-runtime/vm-release-observer.ts -> src/api/services/workload-workflows/retry-recovery.ts',
      'module-ownership:workload-workflows.retry-recovery.ts: src/api/services/repositories/workload-lifecycle.ts -> src/api/services/workload-workflows/retry-recovery.ts',
      'workload-effect-boundary: src/api/services/host-runtime/vm-release-observer.ts -> src/api/services/monitor.ts',
      'workload-effect-boundary: src/api/services/host-runtime/vm-release-observer.ts -> src/api/services/workload-workflows/retry-recovery.ts',
      'workload-effect-boundary: src/api/services/repositories/workload-lifecycle.ts -> src/api/services/workload-workflows/retry-recovery.ts',
      'workload-workflow-boundary: src/api/services/workload-workflows/retry-recovery.ts -> @aws-sdk/client-ec2',
      'workload-workflow-boundary: src/api/services/workload-workflows/retry-recovery.ts -> better-sqlite3',
      'workload-workflow-boundary: src/api/services/workload-workflows/retry-recovery.ts -> src/api/services/gateways/aws.ts',
      'workload-workflow-boundary: src/api/services/workload-workflows/retry-recovery.ts -> src/api/services/monitor.ts',
      'workload-workflow-boundary: src/api/services/workload-workflows/retry-recovery.ts -> src/api/services/persistence.ts',
      'workload-workflow-boundary: src/api/services/workload-workflows/retry-recovery.ts -> src/api/services/provider-clients/aws.ts',
      'workload-workflow-boundary: src/api/services/workload-workflows/retry-recovery.ts -> src/api/services/repositories/db.ts',
    ]);
  });

  it('rejects unresolvable local specifiers while exempting bare packages', async () => {
    expect(
      await cruiseFixture({
        'src/api/suffixed-consumer.ts':
          "import './services/gateways/local-smolvm-runtime.js?fresh';\n",
        'src/api/absolute-consumer.ts': "import '/abs/nowhere.js';\n",
        'src/shared/data-consumer.ts':
          "import 'data:text/javascript,export default 1';\n",
        'src/shared/package-specifier-consumer.ts':
          "import '@scope/test/helpers';\n",
      }),
    ).toEqual([
      'unresolvable-local-import: src/api/absolute-consumer.ts -> /abs/nowhere.js',
      'unresolvable-local-import: src/api/suffixed-consumer.ts -> ./services/gateways/local-smolvm-runtime.js?fresh',
      'unresolvable-local-import: src/shared/data-consumer.ts -> data:export default 1',
    ]);
  });

  it('limits mutation configurations to their explicit tooling consumers', async () => {
    expect(
      await cruiseFixture({
        'stryker.harness.config.mjs': 'export default {};\n',
        'vitest.mutation.config.mjs': 'export default {};\n',
        'scripts/check-mutation-scope.mjs':
          "import '../stryker.harness.config.mjs';\nimport '../vitest.mutation.config.mjs';\n",
        'test/mutation/qualify-sandbox.mjs':
          "import '../../stryker.harness.config.mjs';\n",
        'test/unit/scripts/check-mutation-scope.spec.mjs':
          "import '../../../stryker.harness.config.mjs';\nimport '../../../vitest.mutation.config.mjs';\n",
        'src/consumer.ts': "import '../stryker.harness.config.mjs';\n",
        'scripts/unrelated.mjs': "import '../vitest.mutation.config.mjs';\n",
        'stryker.extra.config.mjs': 'export default {};\n',
        'scripts/nearby-name.mjs': "import '../stryker.extra.config.mjs';\n",
      }),
    ).toEqual([
      'module-ownership:stryker.harness.config.mjs: src/consumer.ts -> stryker.harness.config.mjs',
      'module-ownership:vitest.mutation.config.mjs: scripts/unrelated.mjs -> vitest.mutation.config.mjs',
      'production-source-boundary: src/consumer.ts -> stryker.harness.config.mjs',
      'unexpected-root: scripts/nearby-name.mjs -> stryker.extra.config.mjs',
    ]);
  });

  it('traverses trap names and rejects modules outside known clusterRecords', async () => {
    const entries = await cruiseFixture({
      'src/node_modules-shim.ts': "import '../test/helper.js';\n",
      'test/helper.ts': 'export {};\n',
      'src/hop.ts': "import '../vendor/evil.js';\n",
      'vendor/evil.ts': 'export {};\n',
      'src/hop2.ts': "import '../rootfile.js';\n",
      'rootfile.ts': 'export {};\n',
    });
    expect(entries).toContain(
      'production-source-boundary: src/node_modules-shim.ts -> test/helper.ts',
    );
    expect(entries).toContain('unexpected-root: src/hop.ts -> vendor/evil.ts');
    expect(
      entries.some(
        (entry) =>
          entry.startsWith('unexpected-root: src/hop2.ts') &&
          entry.endsWith('rootfile.ts'),
      ),
    ).toBe(true);
  });
});
