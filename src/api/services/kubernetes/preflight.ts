export interface KubernetesCorePreflightApi {
  readNamespace(args: { name: string }): Promise<unknown>;
}

interface SelfSubjectAccessReviewResult {
  status?: {
    allowed?: boolean;
    reason?: string;
    evaluationError?: string;
  };
}

export interface KubernetesAuthorizationPreflightApi {
  createSelfSubjectAccessReview(args: {
    body: {
      spec: {
        resourceAttributes: {
          namespace?: string;
          verb: string;
          group: string;
          resource: string;
          subresource?: string;
        };
      };
    };
  }): Promise<SelfSubjectAccessReviewResult>;
}

export interface KubernetesPreflightApis {
  core: KubernetesCorePreflightApi;
  authorization: KubernetesAuthorizationPreflightApi;
}

export class KubernetesRbacPreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KubernetesRbacPreflightError';
  }
}

export interface KubernetesRequiredAccess {
  verb: string;
  resource: string;
  subresource?: string;
  group?: string;
  clusterScoped?: boolean;
}

/** The pool loop lists and watches its caches across every namespace. */
const clusterWide = (verb: string) => verb === 'list' || verb === 'watch';

export const KUBERNETES_DEPLOYMENT_REQUIRED_ACCESS: KubernetesRequiredAccess[] =
  [
    // `patch pods` removes the anycloud finalizer; `create` and `delete` run
    // a pool Node's GPU check.
    ...['list', 'watch', 'get', 'patch', 'create', 'delete'].map((verb) => ({
      verb,
      resource: 'pods',
      clusterScoped: clusterWide(verb),
    })),
    // `anycloud logs` for Deployments and Services on node pools.
    { verb: 'get', resource: 'pods', subresource: 'log' },
    // A replica's image pull, from kubelet's events, on its Jobs' claims.
    { verb: 'list', resource: 'events' },
    // `anycloud exec` into a pool Job's or Deployment's replica: a WebSocket
    // GET that Kubernetes 1.35 also authorizes as `create`.
    ...['get', 'create'].map((verb) => ({
      verb,
      resource: 'pods',
      subresource: 'exec',
    })),
    ...['secrets', 'serviceaccounts'].flatMap((resource) =>
      ['create', 'patch', 'get', 'list', 'watch', 'delete'].map((verb) => ({
        verb,
        resource,
        clusterScoped: clusterWide(verb),
      })),
    ),
    ...['create', 'patch', 'get', 'list', 'watch', 'delete'].map((verb) => ({
      verb,
      resource: 'deployments',
      group: 'apps',
      clusterScoped: clusterWide(verb),
    })),
    // The node pool namespace's egress policy: applied, and watched by the
    // pool loop so drift is repaired.
    ...['create', 'patch', 'list', 'watch'].map((verb) => ({
      verb,
      resource: 'networkpolicies',
      group: 'networking.k8s.io',
      clusterScoped: clusterWide(verb),
    })),
    {
      verb: 'create',
      resource: 'tokenreviews',
      group: 'authentication.k8s.io',
      clusterScoped: true,
    },
  ];

function accessName(access: KubernetesRequiredAccess): string {
  return `${access.verb} ${access.resource}${access.subresource ? `/${access.subresource}` : ''}`;
}

export async function preflightKubernetesCluster(
  config: { namespace: string },
  apis: KubernetesPreflightApis,
): Promise<void> {
  await apis.core.readNamespace({ name: config.namespace });
}

async function checkKubernetesAccess(
  config: { namespace: string },
  apis: KubernetesPreflightApis,
  requiredAccess: KubernetesRequiredAccess[],
  profile: string,
): Promise<void> {
  await preflightKubernetesCluster(config, apis);

  for (const access of requiredAccess) {
    const review = await apis.authorization.createSelfSubjectAccessReview({
      body: {
        spec: {
          resourceAttributes: {
            ...(access.clusterScoped ? {} : { namespace: config.namespace }),
            verb: access.verb,
            group: access.group ?? '',
            resource: access.resource,
            subresource: access.subresource,
          },
        },
      },
    });
    if (!review.status?.allowed) {
      const reason =
        review.status?.reason ??
        review.status?.evaluationError ??
        'access denied';
      throw new KubernetesRbacPreflightError(
        `${profile} RBAC preflight failed: ${accessName(access)} in namespace ${config.namespace}: ${reason}`,
      );
    }
  }
}

export function preflightKubernetesDeployment(
  config: { namespace: string },
  apis: KubernetesPreflightApis,
): Promise<void> {
  return checkKubernetesAccess(
    config,
    apis,
    KUBERNETES_DEPLOYMENT_REQUIRED_ACCESS,
    'Kubernetes Deployment',
  );
}
