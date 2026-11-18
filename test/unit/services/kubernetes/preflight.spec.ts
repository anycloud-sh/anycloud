import { readFileSync } from 'node:fs';
import { loadAllYaml } from '@kubernetes/client-node';
import { describe, expect, it, vi } from 'vitest';
import { CLUSTER_PERMISSIONS } from '../../../../src/api/services/kubernetes/cluster-runtime';
import type { LocalKubernetesConfig } from '../../../../src/api/services/kubernetes/config';
import {
  KUBERNETES_DEPLOYMENT_REQUIRED_ACCESS,
  KubernetesRbacPreflightError,
  preflightKubernetesCluster,
  preflightKubernetesDeployment,
  type KubernetesPreflightApis,
} from '../../../../src/api/services/kubernetes/preflight';

const baseConfig: LocalKubernetesConfig = { namespace: 'anycloud' };

function createApis(allowed = true): KubernetesPreflightApis {
  return {
    core: { readNamespace: vi.fn(async () => ({})) },
    authorization: {
      createSelfSubjectAccessReview: vi.fn(async () => ({
        status: {
          allowed,
          reason: allowed ? undefined : 'no policy matched',
        },
      })),
    },
  };
}

describe('preflightKubernetesDeployment', () => {
  it('checks persistent workload, identity, observation, and cleanup access', async () => {
    const apis = createApis();

    await preflightKubernetesDeployment(baseConfig, apis);

    const checked = vi
      .mocked(apis.authorization.createSelfSubjectAccessReview)
      .mock.calls.map(([arg]) => arg.body.spec.resourceAttributes);
    expect(checked).toHaveLength(KUBERNETES_DEPLOYMENT_REQUIRED_ACCESS.length);
    // The pool loop watches cluster-wide, so the check has no namespace.
    expect(checked).toContainEqual({
      verb: 'watch',
      group: '',
      resource: 'pods',
      subresource: undefined,
    });
    expect(checked).toContainEqual({
      namespace: 'anycloud',
      verb: 'create',
      group: 'apps',
      resource: 'deployments',
      subresource: undefined,
    });
    expect(checked).toContainEqual({
      namespace: 'anycloud',
      verb: 'create',
      group: '',
      resource: 'serviceaccounts',
      subresource: undefined,
    });
    expect(checked).toContainEqual({
      verb: 'create',
      group: 'authentication.k8s.io',
      resource: 'tokenreviews',
      subresource: undefined,
    });
    expect(checked).not.toContainEqual(
      expect.objectContaining({ resource: 'services' }),
    );
    expect(checked).not.toContainEqual(
      expect.objectContaining({ resource: 'jobs' }),
    );
  });

  it('reports the denied capability', async () => {
    const apis = createApis(false);

    await expect(
      preflightKubernetesDeployment(baseConfig, apis),
    ).rejects.toEqual(
      expect.objectContaining({
        name: KubernetesRbacPreflightError.name,
        message: expect.stringContaining('RBAC preflight failed'),
      }),
    );
  });

  it('reports missing Pod watch access when all other capabilities are allowed', async () => {
    const apis = createApis();
    vi.mocked(
      apis.authorization.createSelfSubjectAccessReview,
    ).mockImplementation(async ({ body }) => ({
      status: {
        allowed: body.spec.resourceAttributes.verb !== 'watch',
        reason: 'watch not granted',
      },
    }));
    await expect(
      preflightKubernetesDeployment(baseConfig, apis),
    ).rejects.toThrow('watch pods in namespace anycloud: watch not granted');
  });

  it('does not classify Kubernetes transport failures as RBAC rejections', async () => {
    const apis = createApis();
    const failure = new Error('connection refused');
    vi.mocked(apis.core.readNamespace).mockRejectedValue(failure);

    await expect(preflightKubernetesDeployment(baseConfig, apis)).rejects.toBe(
      failure,
    );
  });
});

describe('preflightKubernetesCluster', () => {
  it('validates connectivity without imposing a workload profile', async () => {
    const apis = createApis();

    await preflightKubernetesCluster(baseConfig, apis);

    expect(apis.core.readNamespace).toHaveBeenCalledWith({ name: 'anycloud' });
    expect(
      apis.authorization.createSelfSubjectAccessReview,
    ).not.toHaveBeenCalled();
  });
});

describe('the chart ClusterRole', () => {
  it("grants exactly the cluster preflight's permissions, plus the API's own release and bootstrap", () => {
    const rbac = readFileSync(
      'charts/anycloud-api/templates/rbac.yaml',
      'utf8',
    );
    const role = (
      loadAllYaml(rbac.replace(/^.*\{\{.*\}\}.*$/gm, '')) as {
        kind?: string;
        rules?: { apiGroups: string[]; resources: string[]; verbs: string[] }[];
      }[]
    ).find((document) => document?.kind === 'ClusterRole');
    const granted = role!.rules!.flatMap((rule) =>
      rule.apiGroups.flatMap((group) =>
        rule.resources.flatMap((resource) =>
          rule.verbs.map((verb) => `${verb} ${group} ${resource}`),
        ),
      ),
    );
    const preflight = CLUSTER_PERMISSIONS.map(
      (rule) =>
        `${rule.verb} ${rule.group} ${rule.resource}${rule.subresource ? `/${rule.subresource}` : ''}`,
    );
    // Verbs no node pool, Deployment or Service needs: the release hooks,
    // registry add-on configs and the permission preflight itself.
    const releaseOnly = [
      'get  nodes',
      'list  services',
      'update apps deployments',
      'list apps daemonsets',
      'patch apps daemonsets',
      ...['get', 'list', 'create', 'patch', 'delete'].map(
        (verb) => `${verb} batch jobs`,
      ),
      'patch helm.cattle.io helmcharts',
      ...['get', 'create', 'update', 'patch', 'delete'].map(
        (verb) => `${verb} helm.cattle.io helmchartconfigs`,
      ),
      'create authorization.k8s.io selfsubjectaccessreviews',
    ];
    expect(new Set(granted)).toEqual(new Set([...preflight, ...releaseOnly]));
  });
});
