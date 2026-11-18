import { isContractProcedure, type AnyContractRouter } from '@orpc/contract';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  apiContractMetaSchema,
  type ApiContractMeta,
  type ApiReplayGuarantee,
} from '../../../src/shared/api-contract/base.js';
import { BUCKET_CONTROL_PLANE_TIMEOUT_MS } from '../../../src/shared/api-contract/bucket-metadata.js';
import { apiContract } from '../../../src/shared/api-contract/contract.js';
import {
  diagnosticRouteInventory,
  nativeRouteInventory,
} from '../../../src/shared/api-contract/native-schemas.js';

interface ProcedurePolicy {
  detailedInput: boolean;
  inputSchema: z.ZodType;
  outputSchema: z.ZodType;
  retryableServiceUnavailableCodes: string[];
  method: string;
  path: string;
  successStatus: number;
  meta: ApiContractMeta;
}

const expectedContractEndpoints = {
  'spend.throttles.list': ['GET', '/spend/throttles'],
  'spend.throttles.set': ['PUT', '/spend/throttles/{scope}'],
  'spend.throttles.unset': ['DELETE', '/spend/throttles/{scope}'],
  'spend.budgets.list': ['GET', '/spend/budgets'],
  'spend.budgets.set': ['PUT', '/spend/budgets/{period}/{scope}'],
  'spend.budgets.unset': ['DELETE', '/spend/budgets/{period}/{scope}'],
  'secrets.list': ['GET', '/secrets'],
  'secrets.save': ['PUT', '/secrets/{name}'],
  'secrets.delete': ['DELETE', '/secrets/{name}'],
  'notifications.list': ['GET', '/notifications'],
  'notifications.save': ['PUT', '/notifications/{channel}'],
  'notifications.delete': ['DELETE', '/notifications/{channel}'],
  'notifications.test': ['POST', '/notifications/{channel}/test'],
  'credentials.list': ['GET', '/credentials'],
  'credentials.get': ['GET', '/credentials/{name}'],
  'credentials.save': ['PUT', '/credentials/{name}'],
  'credentials.update': ['PATCH', '/credentials/{name}'],
  'credentials.delete': ['DELETE', '/credentials/{name}'],
  'clusters.list': ['GET', '/clusters'],
  'clusters.get': ['GET', '/clusters/{id}'],
  'clusters.destroy': ['DELETE', '/clusters/{id}'],
  'clusters.forget': ['POST', '/clusters/{id}/forget'],
  'nodePools.create': ['POST', '/node-pools'],
  'nodePools.list': ['GET', '/node-pools'],
  'nodePools.get': ['GET', '/node-pools/{id}'],
  'nodePools.delete': ['DELETE', '/node-pools/{id}'],
  'deployments.create': ['POST', '/deployments'],
  'deployments.list': ['GET', '/deployments'],
  'deployments.get': ['GET', '/deployments/{id}'],
  'deployments.update': ['PATCH', '/deployments/{id}'],
  'deployments.delete': ['DELETE', '/deployments/{id}'],
  'deploymentWorkload.candidate': [
    'GET',
    '/deployments/{deploymentId}/jobs/candidate',
  ],
  'deploymentWorkload.claim': [
    'POST',
    '/deployments/{deploymentId}/jobs/{jobId}/claim',
  ],
  'deploymentWorkload.cancellation': [
    'GET',
    '/deployments/{deploymentId}/jobs/{jobId}/cancellation',
  ],
  'deploymentWorkload.outcome': [
    'POST',
    '/deployments/{deploymentId}/jobs/{jobId}/outcome',
  ],
  'deploymentWorkload.cleanup': [
    'POST',
    '/deployments/{deploymentId}/jobs/{jobId}/cleanup',
  ],
  'deploymentWorkload.execution': [
    'GET',
    '/deployments/{deploymentId}/jobs/{jobId}/execution',
  ],
  'deploymentWorkload.report': [
    'POST',
    '/deployments/{deploymentId}/jobs/{jobId}/report',
  ],
  'apiAccess.list': ['GET', '/api-access/users'],
  'apiAccess.grant': ['POST', '/api-access/users'],
  'apiAccess.revoke': ['DELETE', '/api-access/users/{userId}'],
  'apiAccess.issueServiceToken': ['POST', '/api-access/services'],
  'apiAccess.rotateServiceToken': ['POST', '/api-access/services/{name}/token'],
  'apiAccess.exchangeToken': ['POST', '/api-token'],
  'apiAccess.rotateToken': ['POST', '/api-token/rotate'],
  'database.query': ['POST', '/database/queries'],
  'database.schema': ['GET', '/database/schema'],
  'workloads.cost': ['GET', '/workloads/{id}/cost'],
  'workloads.costReport': ['GET', '/workload-costs'],
  'workloads.list': ['GET', '/workloads'],
  'workloads.terminate': ['DELETE', '/workloads/{id}'],
  'workloads.status': ['GET', '/workloads/{id}'],
  'workloads.sshAccess': ['GET', '/workloads/{id}/ssh-access'],
  'workloads.resubmit': ['POST', '/workloads/{id}/resubmissions'],
  'workloads.observeSubmission': ['POST', '/workloads/{id}/claim-observation'],
  'admission.submit': ['POST', '/workloads'],
  'bucket.list': ['GET', '/credentials/{credentialName}/buckets'],
  'bucket.objects': [
    'GET',
    '/credentials/{credentialName}/buckets/{bucketName}/objects',
  ],
  'bucket.create': [
    'PUT',
    '/credentials/{credentialName}/buckets/{bucketName}',
  ],
  'bucket.delete': [
    'DELETE',
    '/credentials/{credentialName}/buckets/{bucketName}',
  ],
  'bucket.exists': [
    'GET',
    '/credentials/{credentialName}/buckets/{bucketName}',
  ],
  'bucket.deleteObject': [
    'DELETE',
    '/credentials/{credentialName}/buckets/{bucketName}/objects',
  ],
  'bucket.storageTokens': [
    'POST',
    '/credentials/{credentialName}/storage-tokens',
  ],
  'quota.status': ['GET', '/quota/status'],
  'quota.canceled': ['GET', '/quota/canceled'],
  'serviceUpgrade.upgrade': ['POST', '/workloads/{id}/upgrades'],
  'systemRelease.request': ['POST', '/system-release'],
  'systemRelease.status': ['GET', '/system-release'],
  'systemRelease.drain': ['POST', '/system-release/drain'],
  'systemRelease.kubernetes': ['POST', '/system-release/kubernetes'],
  'systemRelease.backup': ['POST', '/system-release/backup'],
  'systemRelease.selfDelete': ['POST', '/system-release/self-delete'],
  'systemRelease.selfDeleteStatus': ['GET', '/system-release/self-delete'],
} as const;

const expectedReplayExceptions = {
  'deploymentWorkload.claim': 'safe',
  'deploymentWorkload.outcome': 'safe',
  'deploymentWorkload.cleanup': 'safe',
  'deploymentWorkload.report': 'safe',
  'database.query': 'safe',
  'bucket.storageTokens': 'safe',
  'apiAccess.exchangeToken': 'safe',
  'workloads.observeSubmission': 'safe',
  'admission.submit': 'not-processed',
  'quota.status': 'never',
  'quota.canceled': 'never',
  'serviceUpgrade.upgrade': 'not-processed',
  'systemRelease.request': 'not-processed',
  'systemRelease.drain': 'safe',
  'systemRelease.kubernetes': 'safe',
  'systemRelease.backup': 'safe',
  // A repeat answers with the delete already running.
  'systemRelease.selfDelete': 'safe',
} as const satisfies Record<string, ApiReplayGuarantee>;

const expectedNonDefaultSuccessStatuses = {
  'spend.throttles.set': 204,
  'spend.throttles.unset': 204,
  'spend.budgets.set': 204,
  'spend.budgets.unset': 204,
  'secrets.save': 204,
  'secrets.delete': 204,
  'notifications.save': 204,
  'notifications.test': 204,
  'credentials.save': 204,
  'credentials.update': 204,
  'credentials.delete': 204,
  'clusters.destroy': 202,
  'nodePools.create': 202,
  'nodePools.delete': 202,
  'deployments.create': 202,
  'deployments.update': 202,
  'deployments.delete': 202,
  'deploymentWorkload.outcome': 204,
  'deploymentWorkload.cleanup': 204,
  'deploymentWorkload.report': 204,
  'apiAccess.revoke': 204,
  'workloads.terminate': 202,
  'workloads.resubmit': 202,
  'admission.submit': 202,
  'bucket.create': 204,
  'bucket.delete': 204,
  'bucket.deleteObject': 204,
  'serviceUpgrade.upgrade': 202,
  'systemRelease.request': 202,
  'systemRelease.selfDelete': 202,
} as const satisfies Record<string, number>;

/**
 * What a second call does when the first one's response was lost.
 * - idempotent: same inputs re-return success with no further effect.
 * - redeliver: the caller re-receives the currently held resource or
 *   assignment (at-least-once handoff).
 * - duplicate: the side effect runs again, so callers must not retry blindly.
 * - conflict: the retry fails loudly, and the value names the recovery read
 *   the caller performs instead.
 * A new command endpoint cannot merge without answering this question. Rows
 * are judgments reviewed against the handlers, not derived facts; the test
 * below only forces every command-shaped route to carry one.
 */
type CommandRetrySemantics =
  | 'idempotent'
  | 'redeliver'
  | 'duplicate'
  | `conflict — recovery: ${string}`;

const expectedCommandRetrySemantics = {
  'spend.throttles.set': 'idempotent', // upsert by scope
  'spend.throttles.unset': 'idempotent', // deleting an absent throttle still returns 204
  'spend.budgets.set': 'idempotent', // upsert by (period, scope)
  'spend.budgets.unset': 'idempotent',
  'secrets.save': 'idempotent', // insert-or-update by name
  'secrets.delete': 'idempotent', // absent secret deletes as a no-op 204
  'notifications.save': 'idempotent', // upsert by channel
  'notifications.delete': 'idempotent', // replay succeeds but reports removed: false
  'notifications.test': 'duplicate', // a delivery probe posts its message again by design
  'credentials.save': 'idempotent', // identical material short-circuits on the credential hash
  'credentials.update': 'idempotent', // replaying the same fields stores the same merged material
  'credentials.delete': 'idempotent', // absent credential deletes as a no-op 204
  'clusters.destroy': 'idempotent', // destroying and destroyed installations re-return their current summary
  'clusters.forget':
    'conflict — recovery: clusters.get returns 404 once the record is forgotten',
  'nodePools.create':
    'conflict — recovery: node pools.get with the client-supplied name, unique per scope',
  'nodePools.delete': 'idempotent', // already-deleting and already-deleted both re-return the node pool
  'deployments.create':
    'conflict — recovery: deployments.get with the client-supplied name, unique per scope',
  'deployments.update': 'duplicate', // replay advances the desired generation again
  'deployments.delete': 'idempotent', // draining and deleted rows re-return their current summary
  'deploymentWorkload.claim': 'redeliver', // the exact Job, revision, and execution UUID recover the same held execution
  'deploymentWorkload.outcome': 'idempotent', // the exact execution and report replay as one transition
  'deploymentWorkload.cleanup': 'idempotent', // matching cleanup acknowledgement is replay-safe
  'deploymentWorkload.report': 'idempotent', // a phase or the recorded end replays as one transition
  'apiAccess.grant': 'idempotent', // upsert by resolved GitHub user id
  'apiAccess.revoke': 'idempotent', // removing an absent user still returns 204
  'apiAccess.issueServiceToken':
    'conflict — recovery: apiAccess.rotateServiceToken; a replay finds the name holding a token (409), and the token is printed only once',
  'apiAccess.rotateServiceToken': 'duplicate', // a replay rotates again; the caller keeps the last token returned
  'apiAccess.exchangeToken': 'idempotent', // returns the same token until it is rotated
  'apiAccess.rotateToken': 'duplicate', // a replay rotates again; the CLI stores the last token returned
  'database.query': 'idempotent', // read-only POST (replay declared safe); swept in by method
  'workloads.terminate': 'idempotent', // re-terminating and terminating a missing workload both return 202
  'workloads.resubmit':
    'conflict — recovery: workloads.status; a resubmitted workload left the resubmittable states, so the retry is rejected (as 400, not 409)',
  'workloads.observeSubmission': 'idempotent', // a revision's unclaimed deadline expires at most once
  'admission.submit':
    'conflict — recovery: workloads.status with the client-supplied id (409 WORKLOAD_ID_CONFLICT); an id-less submit cannot detect the replay and admits a duplicate workload',
  'bucket.create': 'idempotent', // gateways upsert the bucket
  'bucket.delete': 'idempotent', // gateway contract: no-op if the bucket does not exist
  'bucket.deleteObject': 'idempotent', // gateway contract: no-op if the object does not exist
  'bucket.storageTokens': 'duplicate', // a replay mints another short-lived token; neither changes the cloud
  'serviceUpgrade.upgrade':
    'conflict — recovery: workloads.status; queueing moved the workload out of running, so the retry is rejected as 409',
  'systemRelease.request':
    'conflict — recovery: systemRelease.status; a replayed operationId re-returns the recorded release, a stale revision is 409 SYSTEM_RELEASE_STALE',
  'systemRelease.drain': 'idempotent', // renews the claim hold and reads again; force skips replicas already stopping
  'systemRelease.kubernetes': 'idempotent', // the id names one host-step Job; a repeat reports it
  'systemRelease.backup': 'idempotent', // a repeat writes one more backup version; the newest is the restore point
  'systemRelease.selfDelete': 'idempotent', // a repeat while it runs returns its status; refusals change nothing
} as const satisfies Record<string, CommandRetrySemantics>;

const expectedNotProcessedRetryableCodes = {
  'admission.submit': [
    'API_RESTARTING',
    'AUTHENTICATION_UNAVAILABLE',
    'WORKLOAD_ADMISSION_UNAVAILABLE',
  ],
  'serviceUpgrade.upgrade': [
    'API_RESTARTING',
    'AUTHENTICATION_UNAVAILABLE',
    'SERVICE_UPGRADE_UNAVAILABLE',
  ],
  'systemRelease.request': [
    'API_RESTARTING',
    'AUTHENTICATION_UNAVAILABLE',
    'SYSTEM_RELEASE_UNAVAILABLE',
  ],
} satisfies Record<string, string[]>;

const bucketControlPlaneProcedures = [
  'bucket.list',
  'bucket.objects',
  'bucket.create',
  'bucket.delete',
  'bucket.exists',
  'bucket.deleteObject',
  'bucket.storageTokens',
] as const;

const expectedNativeEndpoints = {
  exec: ['POST', '/workloads/{id}/exec', 200, 'ndjson'],
  logs: ['GET', '/workloads/{id}/logs', 200, 'ndjson'],
  uploadBucketObject: [
    'PUT',
    '/credentials/{credentialName}/buckets/{bucketName}/object-content',
    204,
    'bytes',
  ],
  downloadBucketObject: [
    'GET',
    '/credentials/{credentialName}/buckets/{bucketName}/object-content',
    200,
    'bytes',
  ],
} as const;

const expectedDiagnosticEndpoints = {
  health: ['GET', '/health', 200, 'text'],
  version: ['GET', '/version', 200, 'json'],
} as const;

function procedurePolicies(): Record<string, ProcedurePolicy> {
  const result: Record<string, ProcedurePolicy> = {};

  function serviceUnavailableCodes(errorMap: unknown): string[] {
    if (!errorMap || typeof errorMap !== 'object') return [];
    return Object.entries(errorMap)
      .flatMap(([code, definition]) =>
        definition &&
        typeof definition === 'object' &&
        'status' in definition &&
        definition.status === 503
          ? [code]
          : [],
      )
      .sort();
  }

  function visit(router: AnyContractRouter, path: string[]): void {
    if (isContractProcedure(router)) {
      const internals = router['~orpc'];
      result[path.join('.')] = {
        detailedInput: internals.route.inputStructure === 'detailed',
        inputSchema: internals.inputSchema as z.ZodType,
        outputSchema: internals.outputSchema as z.ZodType,
        retryableServiceUnavailableCodes: serviceUnavailableCodes(
          internals.errorMap,
        ),
        method: internals.route.method ?? '',
        path: internals.route.path ?? '',
        successStatus: internals.route.successStatus ?? 200,
        meta: apiContractMetaSchema.parse(internals.meta),
      };
      return;
    }
    for (const [segment, child] of Object.entries(router)) {
      visit(child, [...path, segment]);
    }
  }

  visit(apiContract, []);
  return result;
}

function methodReplay(method: string): ApiReplayGuarantee {
  return ['GET', 'HEAD', 'PUT', 'DELETE'].includes(method) ? 'safe' : 'never';
}

function objectPropertyNames(schema: unknown): Set<string> {
  if (!schema || typeof schema !== 'object') return new Set();
  const node = schema as Record<string, unknown>;
  const names = new Set(
    node.properties && typeof node.properties === 'object'
      ? Object.keys(node.properties)
      : [],
  );
  for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
    const alternatives = node[keyword];
    if (!Array.isArray(alternatives)) continue;
    for (const alternative of alternatives) {
      for (const name of objectPropertyNames(alternative)) names.add(name);
    }
  }
  return names;
}

describe('API contract endpoint policy', () => {
  it('keeps every JSON procedure in the reviewed endpoint inventory', () => {
    const actual = Object.fromEntries(
      Object.entries(procedurePolicies()).map(([name, policy]) => [
        name,
        [policy.method, policy.path],
      ]),
    );
    expect(actual).toEqual(expectedContractEndpoints);
  });

  it('derives replay guarantees from methods except reviewed exceptions', () => {
    for (const [name, procedure] of Object.entries(procedurePolicies())) {
      const exception =
        expectedReplayExceptions[name as keyof typeof expectedReplayExceptions];
      expect(procedure.meta.replay).toBe(
        exception ?? methodReplay(procedure.method),
      );
    }
  });

  it('keeps non-200 success statuses in one reviewed inventory', () => {
    const actual = Object.fromEntries(
      Object.entries(procedurePolicies())
        .filter(([, procedure]) => procedure.successStatus !== 200)
        .map(([name, procedure]) => [name, procedure.successStatus]),
    );
    expect(actual).toEqual(expectedNonDefaultSuccessStatuses);
  });

  it('keeps every command endpoint in the reviewed retry-semantics inventory', () => {
    const commandMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
    const actual = Object.entries(procedurePolicies())
      .filter(([, procedure]) => commandMethods.has(procedure.method))
      .map(([name]) => name)
      .sort();
    expect(actual).toEqual(Object.keys(expectedCommandRetrySemantics).sort());

    for (const [name, semantics] of Object.entries(
      expectedCommandRetrySemantics,
    )) {
      if (semantics.startsWith('conflict')) {
        expect(semantics, `${name} must name its recovery read`).toMatch(
          /^conflict — recovery: \S/u,
        );
      }
    }
  });

  it('keeps user-controlled request objects closed and free of body authentication', () => {
    function assertClosedObjects(
      endpoint: string,
      value: unknown,
      allowOpenRoot: boolean,
      path: string[] = [],
    ): void {
      if (Array.isArray(value)) {
        value.forEach((child, index) =>
          assertClosedObjects(endpoint, child, allowOpenRoot, [
            ...path,
            String(index),
          ]),
        );
        return;
      }
      if (!value || typeof value !== 'object') return;

      const node = value as Record<string, unknown>;
      if (
        node.type === 'object' &&
        'properties' in node &&
        (!allowOpenRoot || path.length > 0)
      ) {
        expect(
          node.additionalProperties,
          `${endpoint} request object ${path.join('.') || '<root>'} must use .strict()`,
        ).toBe(false);
      }
      for (const [key, child] of Object.entries(node)) {
        assertClosedObjects(endpoint, child, allowOpenRoot, [...path, key]);
      }
    }

    const schemas = [
      ...Object.entries(procedurePolicies()).map(
        ([name, policy]) =>
          [name, policy.inputSchema, policy.detailedInput] as const,
      ),
      ...Object.entries(nativeRouteInventory).map(
        ([name, route]) =>
          [`native.${name}`, route.requestSchema, false] as const,
      ),
    ];

    for (const [name, schema, allowOpenRoot] of schemas) {
      const jsonSchema = z.toJSONSchema(schema, {
        io: 'input',
        unrepresentable: 'any',
      });
      // oRPC's detailed envelope also carries adapter-owned `headers` and
      // empty structural sections. Its root must strip those, while every
      // user-controlled params/query/body object remains strict.
      assertClosedObjects(name, jsonSchema, allowOpenRoot);
      expect(
        JSON.stringify(jsonSchema),
        `${name} must use Bearer auth only`,
      ).not.toContain('"accessToken"');
    }
  });

  it('keeps detailed request-part fields disjoint', () => {
    for (const [name, procedure] of Object.entries(procedurePolicies())) {
      if (!procedure.detailedInput) continue;
      const jsonSchema = z.toJSONSchema(procedure.inputSchema, {
        io: 'input',
        unrepresentable: 'any',
      }) as { properties?: Record<string, unknown> };
      const owners = new Map<string, string>();
      for (const part of ['params', 'query', 'body']) {
        for (const field of objectPropertyNames(
          jsonSchema.properties?.[part],
        )) {
          expect(
            owners.get(field),
            `${name} declares ${field} in both ${owners.get(field) ?? 'an earlier request part'} and ${part}`,
          ).toBeUndefined();
          owners.set(field, part);
        }
      }
    }
  });

  it('keeps fixed-shape response objects closed against silent field loss', () => {
    function assertClosedObjects(
      endpoint: string,
      value: unknown,
      path: string[] = [],
    ): void {
      if (Array.isArray(value)) {
        value.forEach((child, index) =>
          assertClosedObjects(endpoint, child, [...path, String(index)]),
        );
        return;
      }
      if (!value || typeof value !== 'object') return;

      const node = value as Record<string, unknown>;
      if (node.type === 'object' && 'properties' in node) {
        expect(
          node.additionalProperties,
          `${endpoint} response object ${path.join('.') || '<root>'} must use .strict()`,
        ).toBe(false);
      }
      for (const [key, child] of Object.entries(node)) {
        assertClosedObjects(endpoint, child, [...path, key]);
      }
    }

    for (const [name, procedure] of Object.entries(procedurePolicies())) {
      assertClosedObjects(
        name,
        z.toJSONSchema(procedure.outputSchema, {
          io: 'output',
          unrepresentable: 'any',
        }),
      );
    }
  });

  it('keeps not-processed retries limited to declared 503 errors', () => {
    const actual = Object.fromEntries(
      Object.entries(procedurePolicies())
        .filter(([, procedure]) => procedure.meta.replay === 'not-processed')
        .map(([name, procedure]) => [
          name,
          procedure.retryableServiceUnavailableCodes,
        ]),
    );
    expect(actual).toEqual(expectedNotProcessedRetryableCodes);
  });

  it('gives every provider-backed bucket procedure the shared timeout budget', () => {
    const policies = procedurePolicies();
    for (const name of bucketControlPlaneProcedures) {
      expect(policies[name].meta.timeoutMs, name).toBe(
        BUCKET_CONTROL_PLANE_TIMEOUT_MS,
      );
    }
  });

  it("limits the 30-second request budget to Deployment acquisition, cancellation, submission observation, and a role connection's check", () => {
    const actual = Object.entries(procedurePolicies())
      .filter(([, procedure]) => procedure.meta.timeoutMs === 30_000)
      .map(([name]) => name)
      .sort();
    expect(actual).toEqual([
      'credentials.save',
      'deploymentWorkload.cancellation',
      'deploymentWorkload.candidate',
      'deploymentWorkload.claim',
      'workloads.observeSubmission',
    ]);
  });

  it('keeps every native stream in the reviewed endpoint inventory', () => {
    const actual = Object.fromEntries(
      Object.entries(nativeRouteInventory).map(([name, route]) => [
        name,
        [route.method, route.path, route.successStatus, route.transport],
      ]),
    );
    expect(actual).toEqual(expectedNativeEndpoints);
  });

  it('keeps every production diagnostic in the reviewed endpoint inventory', () => {
    const actual = Object.fromEntries(
      Object.entries(diagnosticRouteInventory).map(([name, route]) => [
        name,
        [route.method, route.path, route.successStatus, route.transport],
      ]),
    );
    expect(actual).toEqual(expectedDiagnosticEndpoints);
  });
});
