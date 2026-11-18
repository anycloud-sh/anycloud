import { generateKeyPairSync } from 'crypto';
import { once } from 'events';
import { createServer } from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TokenCredential } from '@azure/identity';
import {
  armEndpoint,
  azureAuthorityHost,
  gcpApiEndpoint,
  gcpGapicEndpointOptions,
  gcpUniverseDomain,
  lambdaApiBase,
} from '../../../src/api/services/cloud-endpoints.js';
import { log } from '../../../src/api/services/logger.js';
import { createAzureResourceManagementClient } from '../../../src/api/services/provider-clients/azure.js';
import {
  createGcpBigQueryClient,
  createGcpGatewayClients,
} from '../../../src/api/services/provider-clients/gcp.js';

const GCP_SDK_ENDPOINT_VARS = [
  'STORAGE_EMULATOR_HOST',
  'BIGQUERY_EMULATOR_HOST',
] as const;
const OVERRIDE_VARS = [
  'AZURE_RESOURCE_MANAGER_ENDPOINT',
  'AZURE_AUTHORITY_HOST',
  'GCP_API_ENDPOINT',
  'GOOGLE_CLOUD_UNIVERSE_DOMAIN',
  ...GCP_SDK_ENDPOINT_VARS,
  'LAMBDA_API_BASE_URL',
];
const ORIGINAL_OVERRIDE_VALUES = new Map(
  OVERRIDE_VARS.map((name) => [name, process.env[name]] as const),
);

const fakeTokenCredential: TokenCredential = {
  getToken: async () => null,
};

describe('cloud endpoints', () => {
  beforeEach(() => {
    for (const name of OVERRIDE_VARS) {
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of OVERRIDE_VARS) {
      const original = ORIGINAL_OVERRIDE_VALUES.get(name);
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    }
    vi.restoreAllMocks();
  });

  it('returns production defaults when no override is set', () => {
    expect(armEndpoint()).toBe('https://management.azure.com');
    expect(azureAuthorityHost()).toBe('https://login.microsoftonline.com');
    expect(gcpApiEndpoint()).toBeUndefined();
    expect(gcpGapicEndpointOptions()).toBeUndefined();
    expect(gcpUniverseDomain()).toBeUndefined();
    expect(lambdaApiBase()).toBe('https://cloud.lambda.ai/api/v1');
  });

  it('reads the variable on every call and strips trailing slashes', () => {
    expect(armEndpoint()).toBe('https://management.azure.com');
    process.env.AZURE_RESOURCE_MANAGER_ENDPOINT = 'https://127.0.0.1:4443///';
    expect(armEndpoint()).toBe('https://127.0.0.1:4443');
  });

  it('logs an active override once', () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => undefined);
    process.env.LAMBDA_API_BASE_URL = 'http://127.0.0.1:8080';
    expect(lambdaApiBase()).toBe('http://127.0.0.1:8080');
    expect(lambdaApiBase()).toBe('http://127.0.0.1:8080');
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith('Cloud endpoint override active', {
      name: 'LAMBDA_API_BASE_URL',
      value: 'http://127.0.0.1:8080',
    });
  });

  it('routes newly built ARM clients through an override set mid-process', () => {
    const before = createAzureResourceManagementClient(
      fakeTokenCredential,
      'sub-1',
    );
    expect(before.$host).toBe('https://management.azure.com');
    process.env.AZURE_RESOURCE_MANAGER_ENDPOINT = 'https://127.0.0.1:4443';
    const after = createAzureResourceManagementClient(
      fakeTokenCredential,
      'sub-1',
    );
    expect(after.$host).toBe('https://127.0.0.1:4443');
  });

  it.each([
    [
      'https://127.0.0.1:4443',
      'https://127.0.0.1:4443',
      { apiEndpoint: '127.0.0.1', port: 4443, protocol: 'https' },
    ],
    [
      'http://fake.gcp.internal',
      'http://fake.gcp.internal',
      { apiEndpoint: 'fake.gcp.internal', port: 80, protocol: 'http' },
    ],
    [
      'https://fake.gcp.internal:443/',
      'https://fake.gcp.internal',
      { apiEndpoint: 'fake.gcp.internal', port: 443, protocol: 'https' },
    ],
  ] as const)(
    'normalizes the GCP origin %s for every client shape',
    (raw, normalized, gapicOptions) => {
      process.env.GCP_API_ENDPOINT = raw;
      expect(gcpApiEndpoint()).toBe(normalized);
      expect(gcpGapicEndpointOptions()).toEqual(gapicOptions);
    },
  );

  it.each([
    ['missing scheme', '127.0.0.1:4443'],
    ['non-HTTP protocol', 'ftp://fake.gcp.internal'],
    ['credentials', 'http://user:secret@fake.gcp.internal'],
    ['path prefix', 'http://fake.gcp.internal/fake-gcp'],
    ['query', 'http://fake.gcp.internal?route=fake'],
    ['fragment', 'http://fake.gcp.internal#fake'],
    ['port 0', 'http://fake.gcp.internal:0'],
  ])('rejects an invalid GCP origin with %s', (_case, raw) => {
    process.env.GCP_API_ENDPOINT = raw;
    expect(() => gcpApiEndpoint()).toThrow(
      'GCP_API_ENDPOINT must be an http(s) origin',
    );
  });

  it.each(GCP_SDK_ENDPOINT_VARS)(
    'rejects GCP_API_ENDPOINT when %s is active',
    (variable) => {
      process.env.GCP_API_ENDPOINT = 'http://127.0.0.1:4443';
      process.env[variable] = 'http://127.0.0.1:5555';

      expect(() => gcpApiEndpoint()).toThrow(
        `GCP_API_ENDPOINT cannot be combined with ${variable}`,
      );
    },
  );

  it('routes authenticated GCP SDK requests through the override', async () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
      publicKeyEncoding: { format: 'pem', type: 'spki' },
    });
    const credentials = {
      projectId: 'proj',
      privateKey,
      clientEmail: 'sa@proj.iam.gserviceaccount.com',
    };
    const observed: Array<{
      authorization: string | undefined;
      method: string | undefined;
      path: string;
    }> = [];
    const server = createServer((request, response) => {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      observed.push({
        authorization: request.headers.authorization,
        method: request.method,
        path,
      });
      response.writeHead(200, {
        connection: 'close',
        'content-type': 'application/json',
      });
      if (path.startsWith('/compute/')) response.end('{}');
      else if (path.startsWith('/storage/')) response.end('{"items":[]}');
      else response.end('{"datasets":[]}');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Expected the fake GCP server to listen on a TCP port');
    }
    process.env.GCP_API_ENDPOINT = `http://127.0.0.1:${address.port}`;
    process.env.GOOGLE_CLOUD_UNIVERSE_DOMAIN = 'fake.test';
    let clients: ReturnType<typeof createGcpGatewayClients> | undefined;

    try {
      clients = createGcpGatewayClients(credentials, {});
      await clients.instances.list({
        project: credentials.projectId,
        zone: 'us-central1-a',
      });
      await clients.storage.getBuckets();
      await createGcpBigQueryClient(credentials).getDatasets();

      expect(observed.map(({ method, path }) => ({ method, path }))).toEqual([
        {
          method: 'GET',
          path: '/compute/v1/projects/proj/zones/us-central1-a/instances',
        },
        { method: 'GET', path: '/storage/v1/b' },
        { method: 'GET', path: '/bigquery/v2/projects/proj/datasets' },
      ]);
      for (const request of observed) {
        expect(request.authorization).toMatch(/^Bearer /);
      }
    } finally {
      try {
        if (clients) {
          await Promise.all([
            clients.instances.close(),
            clients.firewalls.close(),
            clients.globalOperations.close(),
            clients.zoneOperations.close(),
            clients.images.close(),
            clients.disks.close(),
            clients.machineTypes.close(),
          ]);
        }
      } finally {
        const closed = once(server, 'close');
        server.close();
        await closed;
      }
    }
  });
});
