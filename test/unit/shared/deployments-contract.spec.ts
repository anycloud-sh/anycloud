import { describe, expect, it } from 'vitest';
import {
  deploymentSummarySchema,
  deploymentResponseSchema,
  createDeploymentInputSchema,
  listDeploymentsInputSchema,
  updateDeploymentInputSchema,
  deploymentReadinessProbeSchema,
} from '../../../src/shared/api-contract/deployments-schemas.js';

describe('persistent Deployment contract', () => {
  it('preserves native probe arguments and delegates omitted timing to Kubernetes', () => {
    const probe = {
      exec: { command: ['sh', '-c', 'test -f "$READY_FILE"', ''] },
    };
    expect(deploymentReadinessProbeSchema.parse(probe)).toEqual(probe);
    for (const readinessProbe of [probe, null]) {
      expect(
        createDeploymentInputSchema.parse({
          name: 'runner',
          image: 'deployment:latest',
          nodePool: 'training',
          readinessProbe,
        }).readinessProbe,
      ).toEqual(readinessProbe);
      expect(
        updateDeploymentInputSchema.parse({
          params: { id: 'runner' },
          body: { readinessProbe },
        }).body,
      ).toEqual({ readinessProbe });
    }
    expect(
      updateDeploymentInputSchema.parse({
        params: { id: 'runner' },
        body: { image: 'replacement:latest' },
      }).body,
    ).not.toHaveProperty('readinessProbe');
  });

  it.each([
    { exec: { command: [] } },
    { exec: { command: [' '] } },
    { exec: { command: ['true'], shell: true } },
    { httpGet: { path: '/ready', port: 8080 } },
    { exec: { command: ['true'] }, periodSeconds: 0 },
    { exec: { command: ['true'] }, timeoutSeconds: 0 },
    { exec: { command: ['true'] }, initialDelaySeconds: -1 },
    { exec: { command: ['true'] }, successThreshold: 1.5 },
    { exec: { command: ['true'] }, failureThreshold: 0 },
  ])('rejects unsupported or invalid readiness configuration: %j', (probe) => {
    expect(deploymentReadinessProbeSchema.safeParse(probe).success).toBe(false);
  });

  it.each([
    null,
    { cpus: '6' },
    { privileged: false, binds: [] },
    {
      cpus: null,
      memory: null,
      shmSize: null,
      gpus: null,
      runtime: null,
      binds: null,
      privileged: null,
    },
  ])(
    'preserves supplied option values and clearing without filling omissions: %j',
    (dockerOptions) => {
      expect(
        updateDeploymentInputSchema.parse({
          params: { id: 'runner' },
          body: { dockerOptions },
        }),
      ).toEqual({ params: { id: 'runner' }, body: { dockerOptions } });
    },
  );

  it.each([
    {},
    { image: undefined },
    { dockerOptions: {} },
    { dockerOptions: { cpus: undefined } },
    { dockerOptions: { unknown: 'value' } },
    { dockerOptions: { network: null } },
    { dockerOptions: { cpus: 6 } },
    { dockerOptions: { privileged: 'false' } },
    { dockerOptions: { binds: '/runtime' } },
    { dockerOptionsUpdate: { cpus: '6' } },
    { dockerOptions: { cpus: '2' }, dockerOptionsUpdate: { cpus: '6' } },
  ])('rejects empty, invalid, or removed option inputs: %j', (body) => {
    expect(() =>
      updateDeploymentInputSchema.parse({ params: { id: 'runner' }, body }),
    ).toThrow();
  });

  it.each([null, { memory: null }, { privileged: null }, { binds: null }])(
    'keeps update-time clearing out of Deployment creation: %j',
    (dockerOptions) => {
      expect(() =>
        createDeploymentInputSchema.parse({
          name: 'runner',
          image: 'deployment:latest',
          nodePool: 'training',
          dockerOptions,
        }),
      ).toThrow();
    },
  );

  it('still accepts empty options when creating a Deployment', () => {
    expect(
      createDeploymentInputSchema.parse({
        name: 'runner',
        image: 'deployment:latest',
        nodePool: 'training',
        dockerOptions: {},
      }).dockerOptions,
    ).toEqual({});
  });

  it.each([undefined, {}, { query: {} }])(
    'preserves unfiltered listing input %j',
    (input) => {
      expect(listDeploymentsInputSchema.parse(input)).toEqual(input);
    },
  );

  it('accepts an optional node pool ID or name for listing', () => {
    expect(
      listDeploymentsInputSchema.parse({ query: { nodePool: ' Training ' } }),
    ).toEqual({ query: { nodePool: 'Training' } });
  });

  it.each([
    { query: { nodePool: '' } },
    { query: { nodePool: '  ' } },
    { query: { nodePoolId: 'node-pool-a' } },
    { query: { cluster: 'training' } },
  ])('rejects invalid listing input %j', (input) => {
    expect(() => listDeploymentsInputSchema.parse(input)).toThrow();
  });

  it('rejects the removed Cluster Deployment response key', () => {
    expect(() =>
      deploymentResponseSchema.parse({ clusterDeployment: {} }),
    ).toThrow();
  });

  it('0029/S2 rejects ingress and generic mode selectors', () => {
    for (const unsupported of [
      { ingress: { port: 8080 } },
      { mode: 'jobs' },
      { accepts: 'jobs' },
    ]) {
      expect(() =>
        createDeploymentInputSchema.parse({
          name: 'deployment',
          image: 'deployment:latest',
          nodePool: 'training',
          ...unsupported,
        }),
      ).toThrow();
      expect(() =>
        updateDeploymentInputSchema.parse({
          params: { id: 'deployment' },
          body: unsupported,
        }),
      ).toThrow();
    }
  });

  it('0029/S16 accepts named Secret references on create and update', () => {
    const create = {
      name: 'deployment',
      image: 'deployment:latest',
      nodePool: 'training',
    };
    expect(
      createDeploymentInputSchema.parse({ ...create, secrets: ['db'] }).secrets,
    ).toEqual(['db']);
    expect(() =>
      createDeploymentInputSchema.parse({ ...create, secrets: ['1-bad'] }),
    ).toThrow();
    for (const secrets of [['db', 'tracking'], null]) {
      expect(
        updateDeploymentInputSchema.parse({
          params: { id: 'deployment' },
          body: { secrets },
        }).body.secrets,
      ).toEqual(secrets);
    }
  });

  it('keeps target and nodePoolId internally consistent on the wire', () => {
    const base = {
      id: 'deployment-a',
      name: 'deployment',
      image: 'deployment:latest',
      command: null,
      readinessProbe: null,
      gracePeriodSeconds: 30,
      status: null,
      gpuCount: 0,
      envKeys: [],
      secretNames: [],
      maxConcurrentJobsPerReplica: 1,
      minReplicas: 1,
      maxReplicas: 1,
      managed: false,
      privileged: false,
      generation: 1,
      deletionRequestedAt: null,
      deletedAt: null,
      createdAt: 1,
      updatedAt: 1,
      jobs: { queued: 0, running: 0, retrying: 0, terminal: 0, unreleased: 0 },
      workload: null,
      usage: null,
    };
    const onNodePool = {
      ...base,
      nodePoolId: 'node-pool-a',
      target: { kind: 'nodePool', nodePoolId: 'node-pool-a' },
    };
    expect(deploymentSummarySchema.parse(onNodePool)).toEqual(onNodePool);
    expect(() =>
      deploymentSummarySchema.parse({
        ...onNodePool,
        nodePoolId: 'node-pool-b',
      }),
    ).toThrow(/same node pool/);
    for (const removed of [
      { ...onNodePool, nodePoolId: null },
      { ...onNodePool, clusterId: '' },
      { ...onNodePool, target: { kind: 'cluster', clusterId: 'cluster-a' } },
    ]) {
      expect(() => deploymentSummarySchema.parse(removed)).toThrow();
    }
  });

  it('0029/S16 never exposes Secret values in Deployment summaries', () => {
    expect(() =>
      deploymentResponseSchema.parse({
        deployment: {
          id: 'deployment-a',
          name: 'deployment',
          nodePoolId: 'node-pool-a',
          target: { kind: 'nodePool', nodePoolId: 'node-pool-a' },
          image: 'deployment:latest',
          command: null,
          readinessProbe: null,
          gracePeriodSeconds: 30,
          status: null,
          gpuCount: 0,
          envKeys: [],
          secretNames: ['application'],
          secrets: { DB_URL: 'value' },
          maxConcurrentJobsPerReplica: 1,
          minReplicas: 1,
          maxReplicas: 1,
          generation: 1,
          deletionRequestedAt: null,
          deletedAt: null,
          createdAt: 1,
          updatedAt: 1,
          jobs: {
            queued: 0,
            running: 0,
            retrying: 0,
            terminal: 0,
            unreleased: 0,
          },
          workload: null,
        },
      }),
    ).toThrow();
  });

  it('rejects environment names Kubernetes cannot put on a Pod', () => {
    for (const name of ['', 'HAS=EQUALS', 'LINE\nBREAK', '\u007f', 'CAFÉ']) {
      const env = { [name]: 'value' };
      expect(() =>
        createDeploymentInputSchema.parse({
          name: 'deployment',
          image: 'deployment:latest',
          nodePool: 'training',
          env,
        }),
      ).toThrow();
      expect(() =>
        updateDeploymentInputSchema.parse({
          params: { id: 'deployment' },
          body: { env },
        }),
      ).toThrow();
    }
  });

  it('accepts relaxed printable Kubernetes environment names', () => {
    const env = { 'APP MODE/PROFILE?': 'fast' };

    expect(() =>
      createDeploymentInputSchema.parse({
        name: 'deployment',
        image: 'deployment:latest',
        nodePool: 'training',
        env,
      }),
    ).not.toThrow();
    expect(() =>
      updateDeploymentInputSchema.parse({
        params: { id: 'deployment' },
        body: { env },
      }),
    ).not.toThrow();
  });

  it.each(['all', '1', '8'])('accepts shared Docker GPU intent %s', (gpus) => {
    const dockerOptions = { gpus, runtime: 'nvidia' };
    expect(
      createDeploymentInputSchema.parse({
        name: 'deployment',
        image: 'deployment:latest',
        nodePool: 'training',
        dockerOptions,
      }).dockerOptions,
    ).toEqual(dockerOptions);
    expect(
      updateDeploymentInputSchema.parse({
        params: { id: 'deployment' },
        body: { dockerOptions },
      }).body.dockerOptions,
    ).toEqual(dockerOptions);
  });

  it.each([0, 1, 8, 'all', null])(
    'rejects the removed Deployment GPU count input %j',
    (gpuCount) => {
      expect(() =>
        createDeploymentInputSchema.parse({
          name: 'deployment',
          image: 'deployment:latest',
          nodePool: 'training',
          gpuCount,
        }),
      ).toThrow();
      expect(() =>
        updateDeploymentInputSchema.parse({
          params: { id: 'deployment' },
          body: { gpuCount },
        }),
      ).toThrow();
    },
  );

  it('rejects the removed Deployment GPU type field', () => {
    expect(() =>
      createDeploymentInputSchema.parse({
        name: 'deployment',
        image: 'deployment:latest',
        nodePool: 'training',
        gpuType: 'h100:1',
      }),
    ).toThrow();
  });
});
