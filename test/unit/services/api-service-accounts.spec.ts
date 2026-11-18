import type { V1TokenReview } from '@kubernetes/client-node';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createHostedApiAuthentication } from '../../../src/api/services/api-authentication.js';
import {
  listServiceAccountDeployments,
  registerApiServiceAccount,
  removeApiAccessUser,
  upsertApiAccessOwner,
} from '../../../src/api/services/repositories/api-access-policy.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import {
  getDeploymentStore,
  resetPersistence,
} from '../../../src/api/services/persistence.js';
import { renderDeploymentObjects } from '../../../src/api/services/deployment-objects.js';
import { kubernetesWorkloadResourceName } from '../../../src/api/services/kubernetes/identity.js';
import { nodePoolNamespace } from '../../../src/api/services/kubernetes/node-pool-scheduling.js';
import {
  makeClusterKubernetesClientFixture,
  makeContainerSpec,
} from '../helpers/fixtures.js';
import { seedReadyNodePool } from '../helpers/node-pool-seed.js';

const scope = { kind: 'api' } as const;
const NAME = 'backmesh/listener';
const POOL = 'node-pool-a';
const CLUSTER = 'cluster-a';

async function createDeployment(id: string, name = NAME): Promise<void> {
  await getDeploymentStore().create(
    {
      id,
      ownerUserId: '1',
      name,
      nodePoolId: POOL,
      config: makeContainerSpec({ image: 'example/listener:latest' }),
      gpuCount: 0,
      maxConcurrentJobsPerReplica: 1,
    },
    scope,
  );
}

const serviceAccountOf = (deploymentId: string) =>
  `system:serviceaccount:${nodePoolNamespace(POOL)}:${kubernetesWorkloadResourceName('deployment', deploymentId)}`;

/**
 * A kube-apiserver's TokenReview: a token it issued authenticates only for
 * an audience it was issued for, as the ServiceAccount it was issued to.
 */
interface IssuedToken {
  audience: string;
  username: string;
  podUid?: string;
}

function harness() {
  const issued = new Map<string, IssuedToken>();
  const createTokenReview = vi.fn(
    async ({ body }: { body: V1TokenReview }): Promise<V1TokenReview> => {
      const token = issued.get(body.spec.token ?? '');
      if (!token || !body.spec.audiences?.includes(token.audience)) {
        return { ...body, status: { authenticated: false } };
      }
      return {
        ...body,
        status: {
          authenticated: true,
          audiences: [token.audience],
          user: {
            username: token.username,
            extra: token.podUid
              ? {
                  'authentication.kubernetes.io/pod-uid': [token.podUid],
                  'authentication.kubernetes.io/pod-name': ['listener-0'],
                }
              : {},
          },
        },
      };
    },
  );
  const resolve = vi.fn(async (clusterId: string) => {
    expect(clusterId).toBe(CLUSTER);
    return {
      cluster: makeClusterKubernetesClientFixture({
        authentication: { createTokenReview },
      }),
    };
  });
  const authenticate = createHostedApiAuthentication({
    listServiceAccounts: () => listServiceAccountDeployments(),
    clusters: { resolve },
  });
  let next = 0;
  /** A JWT-shaped token the fake cluster issued. */
  const issue = (token: IssuedToken) => {
    const jwt = `eyJhbGciOiJSUzI1NiJ9.eyJ${++next}.sig`;
    issued.set(jwt, token);
    return jwt;
  };
  const clientToken = (deploymentId: string) =>
    issue({
      audience: 'anycloud-api',
      username: serviceAccountOf(deploymentId),
      podUid: 'pod-uid',
    });
  return { authenticate, issue, clientToken, createTokenReview };
}

describe('RFC 0049 C29 ServiceAccount identity', () => {
  beforeEach(async () => {
    resetPersistence();
    await getDB().query('DELETE FROM api_tokens');
    await getDB().query('DELETE FROM api_access_users');
    await getDB().query('DELETE FROM api_access_policy');
    await upsertApiAccessOwner('owner', '1');
    await seedReadyNodePool({ nodePoolId: POOL, clusterId: CLUSTER });
  });

  it('admits a registered Deployment’s anycloud-api token as its principal, with no GitHub sign-in', async () => {
    await createDeployment('listener-1');
    await registerApiServiceAccount(NAME);
    const { authenticate, clientToken, createTokenReview } = harness();

    await expect(
      authenticate(clientToken('listener-1'), undefined),
    ).resolves.toEqual({
      id: 'serviceaccount:backmesh/listener',
      username: NAME,
      token: null,
    });
    expect(createTokenReview.mock.calls[0]![0].body.spec.audiences).toEqual([
      'anycloud-api',
    ]);
  });

  it.each([
    [
      'a wrong audience',
      { audience: 'kubernetes', username: serviceAccountOf('listener-1') },
    ],
    [
      'a replica token',
      {
        audience: 'anycloud-runtime',
        username: serviceAccountOf('listener-1'),
        podUid: 'pod-uid',
      },
    ],
    [
      'a token bound to no Pod',
      { audience: 'anycloud-api', username: serviceAccountOf('listener-1') },
    ],
    [
      'an unregistered Deployment',
      {
        audience: 'anycloud-api',
        username: serviceAccountOf('other-1'),
        podUid: 'pod-uid',
      },
    ],
  ])('refuses %s', async (_name, token) => {
    await createDeployment('listener-1');
    await createDeployment('other-1', 'other');
    await registerApiServiceAccount(NAME);
    const { authenticate, issue } = harness();

    await expect(authenticate(issue(token), undefined)).rejects.toThrow(
      /ServiceAccount token/,
    );
  });

  it('never sends a GitHub token to the cluster', async () => {
    await createDeployment('listener-1');
    await registerApiServiceAccount(NAME);
    const { authenticate, createTokenReview } = harness();

    await expect(authenticate('gho_member', undefined)).rejects.toThrow(
      'not a GitHub token',
    );
    expect(createTokenReview).not.toHaveBeenCalled();
  });

  it('admits a Deployment registered before it was created, and its replacement after a recreate', async () => {
    await expect(registerApiServiceAccount(NAME)).resolves.toEqual({
      userId: 'serviceaccount:backmesh/listener',
      username: NAME,
      deploymentId: null,
    });
    const { authenticate, clientToken } = harness();
    await expect(
      authenticate(clientToken('listener-1'), undefined),
    ).rejects.toThrow(/no registered Deployment/);

    await createDeployment('listener-1', 'BackMesh/Listener');
    const first = clientToken('listener-1');
    await expect(authenticate(first, undefined)).resolves.toMatchObject({
      id: 'serviceaccount:backmesh/listener',
    });
    expect(
      (await getDeploymentStore().getById('listener-1'))!.apiIdentity,
    ).toBe(true);

    // Deleting the Deployment keeps the registration; its old tokens name a
    // ServiceAccount no live Deployment derives.
    await getDeploymentStore().requestDeletion('listener-1', scope);
    await getDeploymentStore().markDeleted('listener-1');
    await createDeployment('listener-2');
    await expect(authenticate(first, undefined)).rejects.toThrow(
      /no registered Deployment/,
    );
    await expect(
      authenticate(clientToken('listener-2'), undefined),
    ).resolves.toMatchObject({ id: 'serviceaccount:backmesh/listener' });
  });

  it('refuses the next request after removal and names the Deployment to roll', async () => {
    await createDeployment('listener-1');
    await registerApiServiceAccount(NAME);
    const { authenticate, clientToken } = harness();
    const token = clientToken('listener-1');
    await authenticate(token, undefined);

    // The name is trimmed and compares case-insensitively, as at registration.
    await expect(
      removeApiAccessUser('serviceaccount: BackMesh/Listener '),
    ).resolves.toEqual({
      userId: 'serviceaccount:backmesh/listener',
      username: NAME,
      deploymentId: 'listener-1',
    });
    await expect(authenticate(token, undefined)).rejects.toThrow(
      /no registered Deployment/,
    );
    expect(
      (await getDeploymentStore().getById('listener-1'))!.apiIdentity,
    ).toBe(false);
  });

  it('refuses a name a managed Deployment holds, and never gives one the token', async () => {
    await createDeployment('managed-1');
    await getDB().query('UPDATE deployments SET managed = 1 WHERE id = ?', [
      'managed-1',
    ]);

    await expect(registerApiServiceAccount(NAME)).resolves.toEqual({
      managedDeploymentId: 'managed-1',
    });
    // A registration made some other way still mounts nothing on it.
    await getDB().query(
      "INSERT INTO api_access_users (user_id, username) VALUES ('serviceaccount:backmesh/listener', ?)",
      [NAME],
    );
    expect((await getDeploymentStore().getById('managed-1'))!.apiIdentity).toBe(
      false,
    );
    const { authenticate, clientToken } = harness();
    await expect(
      authenticate(clientToken('managed-1'), undefined),
    ).rejects.toThrow(/no registered Deployment/);
  });

  it('mounts the anycloud-api token only on a registered Deployment', async () => {
    await createDeployment('listener-1');
    await createDeployment('other-1', 'other');
    await registerApiServiceAccount(NAME);
    const store = getDeploymentStore();
    const render = async (id: string) =>
      renderDeploymentObjects(
        (await store.getById(id))!,
        nodePoolNamespace(POOL),
        'https://api.example.test',
        { clusterId: CLUSTER, nodePoolId: POOL, nvidiaGpusPerNode: 0 },
      ).kubernetesDeployment.spec!.template.spec!;

    const registered = await render('listener-1');
    expect(registered.volumes!.at(-1)!.projected!.sources).toEqual([
      expect.objectContaining({
        serviceAccountToken: expect.objectContaining({
          audience: 'anycloud-runtime',
        }),
      }),
      {
        serviceAccountToken: {
          audience: 'anycloud-api',
          expirationSeconds: 3600,
          path: 'api-token',
        },
      },
    ]);
    expect(registered.containers[0]!.env).toContainEqual({
      name: 'ANYCLOUD_API_TOKEN_FILE',
      value: '/var/run/secrets/anycloud/api-token',
    });

    const other = await render('other-1');
    expect(JSON.stringify(other)).not.toContain('anycloud-api');
    expect(JSON.stringify(other)).not.toContain('ANYCLOUD_API_TOKEN_FILE');
  });
});
