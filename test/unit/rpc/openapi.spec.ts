import { workloadListRequestSchema } from '../../../src/shared/api-contract/workload-management-schemas.js';
import type { Server } from 'node:http';
import { isContractProcedure } from '@orpc/contract';
import express from 'express';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import config from '../../../src/api/config.js';
import { createApiRpcDomains } from '../../../src/api/composition.js';
import { createApiRpcMiddleware } from '../../../src/api/rpc/express.js';
import { ANYCLOUD_CLIENT_VERSION_HEADER } from '../../../src/shared/api-version.js';
import { apiContract } from '../../../src/shared/api-contract/contract.js';
import { nativeRouteInventory } from '../../../src/shared/api-contract/native-schemas.js';
import { saveCredentialRequestSchema } from '../../../src/shared/api-contract/credentials-schemas.js';
import {
  generateApiOpenApiDocument,
  normalizeOpenApiSchemas,
} from '../../../src/shared/api-contract/openapi.js';

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head'] as const;
// The client window: the current release's client or the previous one's.
const CLIENT_WINDOW_OPERATION_IDS = new Set([
  'submitWorkload',
  'listWorkloads',
  'getWorkloadStatus',
  'terminateWorkload',
  'resubmitWorkload',
  'getWorkloadSshAccess',
  'upgradeService',
  'getWorkloadCost',
  'getWorkloadCostReport',
  'rotateApiToken',
  'listCredentials',
  'getCredential',
  'getQuotaStatus',
]);
// The client window plus any newer client of the same major line.
const RELEASE_WINDOW_OPERATION_IDS = new Set([
  'exchangeApiToken',
  'requestSystemRelease',
  'runKubernetesStep',
  'backupSystemDatabase',
  'getSystemReleaseStatus',
  // A newer CLI deletes the installation an older API runs.
  'requestSelfDelete',
  'getSelfDelete',
]);

type ApiDocument = Awaited<ReturnType<typeof generateApiOpenApiDocument>>;

function countContractProcedures(value: unknown): number {
  if (isContractProcedure(value)) return 1;
  if (typeof value !== 'object' || value === null) return 0;
  return Object.values(value).reduce(
    (count, child) => count + countContractProcedures(child),
    0,
  );
}

function documentOperations(document: ApiDocument) {
  return Object.entries(document.paths ?? {}).flatMap(([pathName, path]) =>
    HTTP_METHODS.flatMap((method) => {
      const operation = path?.[method];
      return operation ? [{ method, operation, pathName }] : [];
    }),
  );
}

function componentSchema(document: ApiDocument, reference: string) {
  const prefix = '#/components/schemas/';
  expect(reference.startsWith(prefix)).toBe(true);
  const name = reference.slice(prefix.length);
  const schema = document.components?.schemas?.[name];
  expect(schema, `missing schema component ${name}`).toBeDefined();
  return schema;
}

// The wire of the named operations and every component they reach, with
// prose stripped.
function operationsWire(document: ApiDocument, operationIds: Set<string>) {
  const operations = Object.fromEntries(
    documentOperations(document)
      .filter(({ operation }) =>
        operationIds.has(operation.operationId as string),
      )
      .map(({ method, pathName, operation }) => [
        `${method} ${pathName}`,
        operation,
      ]),
  );
  expect(Object.keys(operations)).toHaveLength(operationIds.size);
  const components: Record<string, unknown> = {};
  const pending = collectReferences(operations);
  for (let reference = pending.pop(); reference; reference = pending.pop()) {
    if (reference in components) continue;
    const [, , kind, name] = reference.split('/');
    components[reference] = (
      document.components as Record<string, Record<string, unknown>>
    )[kind]?.[name];
    expect(components[reference], `missing ${reference}`).toBeDefined();
    pending.push(...collectReferences(components[reference]));
  }
  return `${JSON.stringify(
    { operations, schemas: components },
    (key, value: unknown) =>
      (key === 'summary' || key === 'description') && typeof value === 'string'
        ? undefined
        : value,
    2,
  )}\n`;
}

function jsonRequestSchema(
  requestBody: ReturnType<
    typeof documentOperations
  >[number]['operation']['requestBody'],
) {
  if (!requestBody || '$ref' in requestBody) return undefined;
  return requestBody.content?.['application/json']?.schema as
    | { $ref?: string }
    | undefined;
}

function collectReferences(
  value: unknown,
  references: string[] = [],
): string[] {
  if (Array.isArray(value)) {
    for (const child of value) collectReferences(child, references);
    return references;
  }
  if (typeof value !== 'object' || value === null) return references;
  for (const [key, child] of Object.entries(value)) {
    if (key === '$ref' && typeof child === 'string') references.push(child);
    else collectReferences(child, references);
  }
  return references;
}

const SCHEMA_ARRAY_KEYS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const SCHEMA_KEYS = new Set([
  'additionalItems',
  'additionalProperties',
  'contains',
  'contentSchema',
  'else',
  'if',
  'items',
  'not',
  'propertyNames',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
]);
const SCHEMA_MAP_KEYS = new Set([
  '$defs',
  'definitions',
  'dependentSchemas',
  'patternProperties',
  'properties',
]);

function collectConstSchemasFromSchema(
  value: unknown,
  paths: string[] = [],
  path: string[] = [],
): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return paths;
  }
  if (Object.hasOwn(value, 'const')) paths.push(path.join('.'));
  for (const [key, child] of Object.entries(value)) {
    if (SCHEMA_MAP_KEYS.has(key) && child && typeof child === 'object') {
      for (const [name, schema] of Object.entries(child)) {
        collectConstSchemasFromSchema(schema, paths, [...path, key, name]);
      }
    } else if (SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(child)) {
      for (const [index, schema] of child.entries()) {
        collectConstSchemasFromSchema(schema, paths, [
          ...path,
          key,
          String(index),
        ]);
      }
    } else if (SCHEMA_KEYS.has(key)) {
      if (Array.isArray(child)) {
        for (const [index, schema] of child.entries()) {
          collectConstSchemasFromSchema(schema, paths, [
            ...path,
            key,
            String(index),
          ]);
        }
      } else {
        collectConstSchemasFromSchema(child, paths, [...path, key]);
      }
    } else if (key === 'dependencies' && child && typeof child === 'object') {
      for (const [name, dependency] of Object.entries(child)) {
        if (!Array.isArray(dependency)) {
          collectConstSchemasFromSchema(dependency, paths, [
            ...path,
            key,
            name,
          ]);
        }
      }
    }
  }
  return paths;
}

function collectConstSchemas(
  value: unknown,
  paths: string[] = [],
  path: string[] = [],
): string[] {
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      collectConstSchemas(child, paths, [...path, String(index)]);
    }
    return paths;
  }
  if (typeof value !== 'object' || value === null) return paths;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'schemas' && path.at(-1) === 'components') {
      if (child && typeof child === 'object') {
        for (const [name, schema] of Object.entries(child)) {
          collectConstSchemasFromSchema(schema, paths, [...path, key, name]);
        }
      }
    } else if (key === 'schema') {
      collectConstSchemasFromSchema(child, paths, [...path, key]);
    } else if (
      key !== 'default' &&
      key !== 'example' &&
      key !== 'examples' &&
      !key.startsWith('x-')
    ) {
      collectConstSchemas(child, paths, [...path, key]);
    }
  }
  return paths;
}

function collectObjectSchemasWithoutAdditionalProperties(
  value: unknown,
  path = '$',
  missing: string[] = [],
): string[] {
  if (Array.isArray(value)) {
    value.forEach((child, index) =>
      collectObjectSchemasWithoutAdditionalProperties(
        child,
        `${path}[${index}]`,
        missing,
      ),
    );
    return missing;
  }
  if (typeof value !== 'object' || value === null) return missing;
  const object = value as Record<string, unknown>;
  if (
    object.type === 'object' &&
    !Object.hasOwn(object, 'additionalProperties')
  ) {
    missing.push(path);
  }
  for (const [key, child] of Object.entries(object)) {
    collectObjectSchemasWithoutAdditionalProperties(
      child,
      `${path}.${key}`,
      missing,
    );
  }
  return missing;
}

function resolveLocalReference(
  document: ApiDocument,
  reference: string,
): unknown {
  if (!reference.startsWith('#/')) return undefined;
  return reference
    .slice(2)
    .split('/')
    .reduce<unknown>((value, segment) => {
      if (typeof value !== 'object' || value === null) return undefined;
      return (value as Record<string, unknown>)[segment];
    }, document);
}

describe('production oRPC OpenAPI document', () => {
  it('covers every contract procedure with stable operation families', async () => {
    const document = await generateApiOpenApiDocument({ version: 'test' });
    const operations = documentOperations(document);
    const operationIds = operations.map(
      ({ operation }) => operation.operationId,
    );

    expect(operations).toHaveLength(countContractProcedures(apiContract));
    expect(operations).toHaveLength(55);
    expect(operationIds.every(Boolean)).toBe(true);
    expect(new Set(operationIds).size).toBe(operationIds.length);
    expect(
      operations.every(({ operation }) => operation.tags?.length === 1),
    ).toBe(true);
    expect(
      new Set(operations.flatMap(({ operation }) => operation.tags ?? [])),
    ).toEqual(
      new Set([
        'API Access',
        'Buckets',
        'Clusters',
        'Credentials',
        'Database',
        'Workload Admission',
        'Workloads',
        'Notifications',
        'Quota',
        'Secrets',
        'Service Upgrades',
        'Spend Controls',
        'System Release',
      ]),
    );
  });

  it('documents bounded JSON and explicitly excludes native transports', async () => {
    const document = await generateApiOpenApiDocument({ version: 'test' });

    // service-terminology-ok: OpenAPI owns this standard document field
    expect(document.servers).toEqual([
      { url: 'http://localhost:8080/v1', description: 'Local API' },
    ]);
    expect(Object.keys(document.paths ?? {})).toHaveLength(39);
    expect(document.paths).toMatchObject({
      '/workloads': {
        get: expect.any(Object),
        post: expect.any(Object),
      },
      '/workloads/{id}/upgrades': { post: expect.any(Object) },
      '/credentials/{name}': {
        get: expect.any(Object),
        put: expect.any(Object),
        patch: expect.any(Object),
        delete: expect.any(Object),
      },
      '/credentials/{credentialName}/buckets/{bucketName}/objects': {
        get: expect.any(Object),
        delete: expect.any(Object),
      },
      '/quota/status': { get: expect.any(Object) },
      '/quota/canceled': { get: expect.any(Object) },
      '/clusters': { get: expect.any(Object) },
      '/clusters/{id}': {
        get: expect.any(Object),
        delete: expect.any(Object),
      },
      '/system-release': { post: expect.any(Object), get: expect.any(Object) },
    });
    expect(document.paths).not.toHaveProperty('/quota/operations');
    expect(document.paths).not.toHaveProperty('/quota/operations/{id}');
    expect(document.paths).not.toHaveProperty('/workloads/{id}/exec');
    expect(document.paths).not.toHaveProperty('/workloads/{id}/logs');
    expect(document.paths).not.toHaveProperty(
      '/credentials/{credentialName}/buckets/{bucketName}/object-content',
    );
  });

  it('documents Workload submission and no retired surfaces', async () => {
    const document = await generateApiOpenApiDocument({ version: 'test' });

    expect(document.paths?.['/workloads']?.post).toMatchObject({
      operationId: 'submitWorkload',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/WorkloadAdmissionInput',
            },
          },
        },
      },
    });
    // The retired independent-Cluster and Kubernetes-root surfaces are gone;
    // `/clusters` is the installation's one Kubernetes cluster.
    expect(document.paths).not.toHaveProperty('/roots');
    expect(document.paths).not.toHaveProperty('/root-installations');
    expect(document.paths).not.toHaveProperty('/cluster-deployments');
    expect(document.paths).not.toHaveProperty('/cluster-deployments/{id}');
    expect(document.paths).not.toHaveProperty('/deployments');
    expect(document.paths).not.toHaveProperty('/node-pools');
    // A removed filter is refused, never ignored: a list-then-terminate
    // script must not get every Workload back.
    expect(
      workloadListRequestSchema.safeParse({ query: { deploymentId: 'web' } })
        .success,
    ).toBe(false);
  });

  it('documents user authentication and the client version on every operation', async () => {
    const document = await generateApiOpenApiDocument({ version: 'test' });
    const operations = documentOperations(document);

    expect(document.components?.securitySchemes).toMatchObject({
      userBearer: { type: 'http', scheme: 'bearer' },
    });
    expect(document.components?.parameters?.AnyCloudClientVersion).toEqual({
      name: 'AnyCloud-Client-Version',
      in: 'header',
      required: true,
      description: expect.stringContaining('previous release'),
      schema: { type: 'string' },
    });

    for (const { operation } of operations) {
      const operationId = operation.operationId as string;
      const versionParameters = (operation.parameters ?? []).filter(
        (parameter) =>
          '$ref' in parameter &&
          parameter.$ref === '#/components/parameters/AnyCloudClientVersion',
      );
      expect(operation.security, operationId).toEqual([{ userBearer: [] }]);
      expect(versionParameters, operationId).toHaveLength(1);
    }
  });

  // The client window admits the previous release's CLI, which doesn't
  // validate responses: an added response field keeps it working, while a
  // removed or changed field breaks it. Update the snapshot for an addition,
  // or for an approved break, and say which in the PR. The Python SDK is
  // upgraded with the API, so it isn't held to this.
  it('keeps the client-window operations on the previous release wire', async () => {
    const document = await generateApiOpenApiDocument({ version: 'test' });
    await expect(
      operationsWire(
        document,
        new Set([
          ...CLIENT_WINDOW_OPERATION_IDS,
          ...RELEASE_WINDOW_OPERATION_IDS,
        ]),
      ),
    ).toMatchFileSnapshot('__snapshots__/client-window-openapi.snap');
  });

  // The native workload streams take the same window; their requests are
  // outside the OpenAPI document, so their inventory entries freeze here.
  it('keeps the client-window native streams on the previous release wire', async () => {
    const streams = Object.fromEntries(
      (['logs', 'exec'] as const).map((name) => {
        const { requestSchema, ...route } = nativeRouteInventory[name];
        return [
          name,
          { ...route, request: z.toJSONSchema(requestSchema, { io: 'input' }) },
        ];
      }),
    );
    await expect(`${JSON.stringify(streams, null, 2)}\n`).toMatchFileSnapshot(
      '__snapshots__/client-window-native.snap',
    );
  });

  it('exports transformed query defaults in their wire representation', async () => {
    const credential = {
      cloudProvider: 'AWS' as const,
      accessKeyId: 'access-key',
      secretAccessKey: 'secret-key',
    };
    expect(
      saveCredentialRequestSchema.parse({
        params: { name: 'credential' },
        query: {},
        body: credential,
      }).overwrite,
    ).toBe(true);
    expect(
      saveCredentialRequestSchema.parse({
        params: { name: 'credential' },
        query: { overwrite: 'false' },
        body: credential,
      }).overwrite,
    ).toBe(false);

    const document = await generateApiOpenApiDocument({ version: 'test' });
    const overwrite = document.paths?.[
      '/credentials/{name}'
    ]?.put?.parameters?.find(
      (parameter) => 'name' in parameter && parameter.name === 'overwrite',
    );
    expect(overwrite).toMatchObject({
      in: 'query',
      schema: {
        default: 'true',
        anyOf: [{ $ref: '#/components/schemas/BooleanQueryValue' }],
      },
    });
  });

  it('emits no content schema for every 204 response', async () => {
    const document = await generateApiOpenApiDocument({ version: 'test' });
    const responses = documentOperations(document).flatMap(({ operation }) => {
      const response = operation.responses?.[204];
      return response ? [response] : [];
    });

    expect(responses).toHaveLength(15);
    for (const response of responses) {
      expect(response).not.toHaveProperty('content');
    }
  });

  it('uses named components for every public JSON body', async () => {
    const document = await generateApiOpenApiDocument({ version: 'test' });
    const schemas = document.components?.schemas ?? {};

    expect(Object.keys(schemas).length).toBeGreaterThan(100);
    const references = new Set(collectReferences(document));
    for (const name of Object.keys(schemas)) {
      expect(
        references.has(`#/components/schemas/${name}`),
        `unreferenced schema component ${name}`,
      ).toBe(true);
    }
    for (const { operation } of documentOperations(document)) {
      const requestSchema = jsonRequestSchema(operation.requestBody);
      if (requestSchema) {
        expect(requestSchema.$ref, operation.operationId).toBeDefined();
        componentSchema(document, requestSchema.$ref as string);
      }

      for (const [status, response] of Object.entries(
        operation.responses ?? {},
      )) {
        if (!status.startsWith('2') || '$ref' in response) continue;
        const responseSchema = response.content?.['application/json']
          ?.schema as { $ref?: string } | undefined;
        if (!responseSchema) continue;
        expect(
          responseSchema.$ref,
          `${operation.operationId}/${status}`,
        ).toBeDefined();
        componentSchema(document, responseSchema.$ref as string);
      }
    }

    const admissionReference = jsonRequestSchema(
      document.paths?.['/workloads']?.post?.requestBody,
    ) as { $ref: string };
    expect(admissionReference.$ref).toBe(
      '#/components/schemas/WorkloadAdmissionInput',
    );
    expect(componentSchema(document, admissionReference.$ref)).toMatchObject({
      required: ['image', 'cloudConfig'],
      additionalProperties: false,
    });
  });

  it('emits typed single-value enums for literal schemas', async () => {
    const document = await generateApiOpenApiDocument({ version: 'test' });

    expect(document.components?.schemas?.AwsCredential).toMatchObject({
      properties: {
        cloudProvider: { type: 'string', enum: ['AWS'] },
      },
    });
    expect(document.components?.schemas?.BucketEntryPage).toMatchObject({
      properties: {
        entries: {
          items: {
            anyOf: [
              { properties: { kind: { type: 'string', enum: ['prefix'] } } },
              { properties: { kind: { type: 'string', enum: ['object'] } } },
            ],
          },
        },
      },
    });
    expect(document.components?.schemas?.DbSchemaResponse).toMatchObject({
      properties: {
        tables: {
          items: {
            properties: {
              columns: {
                items: {
                  properties: {
                    notNull: { type: 'boolean', enum: [true] },
                  },
                },
              },
            },
          },
        },
      },
    });
    expect(document.components?.schemas?.UnauthorizedApiError).toMatchObject({
      properties: {
        status: { type: 'integer', enum: [401] },
      },
    });
    expect(collectConstSchemas(document)).toEqual([]);
  });

  it('normalizes nested schemas without rewriting arbitrary JSON payloads', () => {
    const document = normalizeOpenApiSchemas({
      openapi: '3.1.0',
      components: {
        schemas: {
          Literals: {
            required: ['text'],
            additionalProperties: false,
            default: { const: 'default-payload' },
            examples: [{ const: 'example-payload' }],
            'x-payload': { const: 'extension-payload' },
            properties: {
              text: { const: 'value' },
              enabled: { const: false },
              count: { const: 2 },
              ratio: { const: 1.5, nullable: true },
              empty: { const: null },
              list: { items: { const: 'item' } },
              dictionary: { additionalProperties: { const: 3 } },
              reference: { $ref: '#/components/schemas/Referenced' },
              referenceWithDefault: {
                $ref: '#/components/schemas/Referenced',
                default: 'referenced',
              },
              referenceWithUnion: {
                $ref: '#/components/schemas/Referenced',
                anyOf: [{ const: 'alternative' }],
              },
              allowAnything: true,
              allowNothing: false,
            },
            anyOf: [{ const: 'union' }, { type: 'null' }],
            $defs: { nested: { const: 'definition' } },
            dependentSchemas: { text: { const: 'dependent' } },
            dependencies: {
              count: { const: 'legacy-dependent' },
              text: ['count'],
            },
          },
        },
        examples: {
          Payload: { value: { const: 'component-example' } },
        },
      },
      paths: {
        '/example': {
          post: {
            'x-payload': { const: 'operation-extension' },
            requestBody: {
              content: {
                'application/json': {
                  example: { const: 'media-example' },
                  schema: { properties: { kind: { const: 'inline' } } },
                },
              },
            },
          },
        },
      },
    });

    expect(document.components.schemas.Literals).toMatchObject({
      required: ['text'],
      additionalProperties: false,
      default: { const: 'default-payload' },
      examples: [{ const: 'example-payload' }],
      'x-payload': { const: 'extension-payload' },
      properties: {
        text: { type: 'string', enum: ['value'] },
        enabled: { type: 'boolean', enum: [false] },
        count: { type: 'integer', enum: [2] },
        ratio: { type: 'number', enum: [1.5], nullable: true },
        empty: { type: 'null', enum: [null] },
        list: { items: { type: 'string', enum: ['item'] } },
        dictionary: {
          additionalProperties: { type: 'integer', enum: [3] },
        },
        reference: { $ref: '#/components/schemas/Referenced' },
        referenceWithDefault: {
          default: 'referenced',
          anyOf: [{ $ref: '#/components/schemas/Referenced' }],
        },
        referenceWithUnion: {
          anyOf: [{ type: 'string', enum: ['alternative'] }],
          oneOf: [{ $ref: '#/components/schemas/Referenced' }],
        },
        allowAnything: true,
        allowNothing: false,
      },
      anyOf: [{ type: 'string', enum: ['union'] }, { type: 'null' }],
      $defs: { nested: { type: 'string', enum: ['definition'] } },
      dependentSchemas: {
        text: { type: 'string', enum: ['dependent'] },
      },
      dependencies: {
        count: { type: 'string', enum: ['legacy-dependent'] },
        text: ['count'],
      },
    });
    expect(
      document.paths['/example'].post.requestBody.content['application/json'],
    ).toEqual({
      example: { const: 'media-example' },
      schema: {
        properties: { kind: { type: 'string', enum: ['inline'] } },
      },
    });
    expect(document.components.examples).toEqual({
      Payload: { value: { const: 'component-example' } },
    });
    expect(document.paths['/example'].post['x-payload']).toEqual({
      const: 'operation-extension',
    });
    expect(collectConstSchemas(document)).toEqual([]);
  });

  it('makes every object schema additional-properties behavior explicit', async () => {
    const document = await generateApiOpenApiDocument({ version: 'test' });

    expect(collectObjectSchemasWithoutAdditionalProperties(document)).toEqual(
      [],
    );
  });

  it('derives named, discriminated declared-error schemas', async () => {
    const document = await generateApiOpenApiDocument({ version: 'test' });

    expect(document.components?.schemas?.UnauthorizedApiError).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: {
        defined: { type: 'boolean', enum: [true] },
        code: { type: 'string', enum: ['UNAUTHORIZED'] },
        status: { type: 'integer', enum: [401] },
        message: { type: 'string' },
      },
      required: ['defined', 'code', 'status', 'message'],
    });
    expect(document.components?.schemas?.CredentialInUseApiError).toMatchObject(
      {
        properties: {
          data: { $ref: '#/components/schemas/CredentialInUseData' },
        },
        required: expect.arrayContaining(['data']),
      },
    );
    expect(document.components?.schemas?.UndefinedApiError).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: {
        defined: { type: 'boolean', enum: [false] },
        code: { type: 'string' },
        status: { type: 'integer' },
      },
    });

    for (const { operation } of documentOperations(document)) {
      for (const [status, response] of Object.entries(
        operation.responses ?? {},
      )) {
        if (status.startsWith('2') || '$ref' in response) continue;
        const schema = response.content?.['application/json']?.schema as
          | {
              discriminator?: {
                mapping?: Record<string, string>;
                propertyName?: string;
              };
              oneOf?: { $ref?: string }[];
            }
          | undefined;
        expect(schema, `${operation.operationId}/${status}`).toBeDefined();
        expect(schema?.discriminator?.propertyName).toBe('code');
        expect(schema?.oneOf?.at(-1)).toEqual({
          $ref: '#/components/schemas/UndefinedApiError',
        });
        for (const reference of schema?.oneOf ?? []) {
          expect(reference.$ref).toBeDefined();
          componentSchema(document, reference.$ref as string);
        }
        for (const reference of Object.values(
          schema?.discriminator?.mapping ?? {},
        )) {
          componentSchema(document, reference);
        }
      }
    }
  });

  it('contains no dangling local component references', async () => {
    const document = await generateApiOpenApiDocument({ version: 'test' });
    const missing = collectReferences(document).filter(
      (reference) =>
        reference.startsWith('#/') &&
        resolveLocalReference(document, reference) === undefined,
    );
    expect(missing).toEqual([]);
  });

  it('names Workload operations without Worker aliases', async () => {
    const document = await generateApiOpenApiDocument({ version: 'test' });
    const serialized = JSON.stringify(document);
    expect(document.paths?.['/workloads']?.get?.operationId).toBe(
      'listWorkloads',
    );
    expect(document.paths?.['/workloads']?.post?.operationId).toBe(
      'submitWorkload',
    );
    expect(serialized).not.toMatch(/worker/i);
    expect(serialized).not.toContain('deploymentType');
    expect(document.components?.schemas?.WorkloadStatusResponse).toMatchObject({
      required: expect.arrayContaining(['workload']),
    });
  });
});

describe('client version windows', () => {
  it('admits each operation exactly the client versions its window names', async () => {
    const app = express();
    app.use(
      createApiRpcMiddleware({
        authenticate: async () => {
          throw new Error('Invalid access token');
        },
        domains: createApiRpcDomains(),
      }),
    );
    const server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Expected an ephemeral TCP address');
      }
      const document = await generateApiOpenApiDocument({ version: 'test' });
      const operations = documentOperations(document);
      const [major, minor, patch] = config.currVersion.split('.').map(Number);
      const newer = `${major}.${minor}.${patch + 3}`;
      const tooOld = `${major}.${minor}.${patch - 2}`;
      expect(config.previousVersion).not.toBe(config.currVersion);
      expect(config.previousVersion).not.toBe(tooOld);

      const admitted = async (
        method: string,
        path: string,
        version: string,
      ) => {
        const response = await fetch(
          `http://127.0.0.1:${address.port}/v1${path.replace(/\{[^}]+\}/g, 'x')}`,
          {
            method: method.toUpperCase(),
            headers: { [ANYCLOUD_CLIENT_VERSION_HEADER]: version },
          },
        );
        const body = (await response.json()) as { code?: string };
        // Admitted requests reach authentication, which has no bearer.
        expect([400, 401], `${method} ${path} ${version}`).toContain(
          response.status,
        );
        return body.code !== 'CLIENT_VERSION_MISMATCH';
      };

      for (const { method, pathName, operation } of operations) {
        const id = operation.operationId as string;
        const clientWindow =
          CLIENT_WINDOW_OPERATION_IDS.has(id) ||
          RELEASE_WINDOW_OPERATION_IDS.has(id);
        expect([
          id,
          await admitted(method, pathName, config.currVersion),
          await admitted(method, pathName, config.previousVersion),
          await admitted(method, pathName, newer),
          await admitted(method, pathName, tooOld),
        ]).toEqual([
          id,
          true,
          clientWindow,
          RELEASE_WINDOW_OPERATION_IDS.has(id),
          false,
        ]);
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
