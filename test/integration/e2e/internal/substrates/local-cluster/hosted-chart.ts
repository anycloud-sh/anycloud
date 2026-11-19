import { cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { KubernetesClients } from '../../../../../../src/api/services/kubernetes/client.js';
import type { ClusterConnectionDocument } from '../../../../../../src/api/services/kubernetes/cluster-connection.js';
import {
  buildSystemReleaseHelmChart,
  type HelmChartObject,
} from '../../../../../../src/shared/system-release-values.js';
import { readyJobName } from '../../../../../../src/api/services/system-release/ready-job.js';
import {
  MANAGEMENT_MEMBER_LABEL,
  apiImageTagReference,
  pinnedApiImage,
  SYSTEM_RELEASE_HELM_CHART_NAME,
  SYSTEM_RELEASE_HELM_JOB_IMAGE,
  SYSTEM_RELEASE_NAMESPACE,
} from '../../../../../../src/shared/system-release.js';
import packageJson from '../../../../../../package.json' with { type: 'json' };
import {
  inHelm,
  publishApiChart,
} from '../../../../../../scripts/api-chart.js';
import type { Waiter } from '../../wait.js';
import { executeLocalKubernetesCommand } from './command.js';
import { clusterLocalDockerLabel } from './constants.js';

/** The chart's API selector from a newer chart, which the older chart lacks. */
const PROTECTED_SELECTOR = `${MANAGEMENT_MEMBER_LABEL}:`;
/** The v0.1.65 chart's gap: `anycloud logs` on a Deployment needs this rule. */
const POD_LOG_RULE = `  # \`anycloud logs\` for Deployments and Services on node pools.
  - apiGroups: ['']
    resources: ['pods/log']
    verbs: ['get']
`;
const SETTLE_MS = 60_000;
/** Serves this tree's chart over plain HTTP, as GHCR serves a release's. */
const REGISTRY_IMAGE =
  'mirror.gcr.io/library/registry:3.0.0@sha256:6c5666b861f3505b116bb9aa9b25175e71210414bd010d92035ff64018f9457e';

const notFound = (error: unknown): undefined => {
  if ((error as { code?: number }).code === 404) return undefined;
  throw error;
};

/**
 * The shape an upgrade from a release before 0.1.68 leaves: a HelmChart with
 * an inline chart that predates the API image it runs (such an upgrade
 * patches only values). The API built from this tree names its own chart,
 * published to a registry beside K3s. It starts from that HelmChart in the
 * fixture's K3s and must switch it to its OCI chart, granting `pods/log`,
 * without restarting itself or re-applying in a loop.
 */
export async function proveHostedChartRepair(input: {
  readonly clients: KubernetesClients;
  readonly container: string;
  /** Public control-plane endpoint and CA, as bootstrap records them. */
  readonly connection: ClusterConnectionDocument;
  readonly kubernetesIdentity: string;
  readonly projectRoot: string;
  readonly stateRoot: string;
  readonly wait: Pick<Waiter, 'for'>;
}) {
  const { clients, container, wait } = input;
  const version = packageJson.version;
  const tag = apiImageTagReference(version);
  const docker = (args: string[], timeoutMs = 300_000) =>
    executeLocalKubernetesCommand('docker', args, { timeoutMs });
  // On Docker's default bridge with the K3s server: Pods reach it by address.
  const registry = `${container}-chart-registry`;
  try {
    await docker([
      'run',
      '--detach',
      '--name',
      registry,
      '--label',
      `${clusterLocalDockerLabel}=true`,
      REGISTRY_IMAGE,
    ]);
    const registryAddress = (
      await docker([
        'inspect',
        '--format',
        '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
        registry,
      ])
    ).stdout.trim();
    if (!registryAddress) throw new Error(`${registry} has no address`);
    const ownChart = await publishApiChart({
      version,
      repository: `oci://${registryAddress}:5000/charts`,
      plainHttp: true,
    });
    await docker(
      [
        'build',
        '--build-arg',
        `API_CHART=${ownChart}`,
        '--tag',
        tag,
        '--file',
        path.join(input.projectRoot, 'Dockerfile'),
        input.projectRoot,
      ],
      1_200_000,
    );
    const archive = path.join(input.stateRoot, 'hosted-api.tar');
    await docker(['image', 'save', '--output', archive, tag]);
    await docker(['cp', archive, `${container}:/tmp/hosted-api.tar`]);
    const ctr = ['exec', container, 'ctr', '-n', 'k8s.io', 'images'];
    await docker([...ctr, 'import', '/tmp/hosted-api.tar']);
    const { stdout } = await docker([...ctr, 'ls', `name==${tag}`]);
    const digest = /sha256:[0-9a-f]{64}/u.exec(stdout)?.[0];
    if (!digest) throw new Error(`K3s did not import ${tag}: ${stdout}`);
    // The HelmChart pins the image by digest, which the kubelet resolves as
    // `<repository>@<digest>`; without that name it pulls from the registry.
    await docker([...ctr, 'tag', tag, `${packageJson.apiImage}@${digest}`]);

    const olderDirectory = path.join(input.stateRoot, 'anycloud-api-0.1.65');
    await cp(
      path.join(input.projectRoot, 'charts/anycloud-api'),
      olderDirectory,
      {
        recursive: true,
      },
    );
    const rbac = path.join(olderDirectory, 'templates/rbac.yaml');
    const rules = await readFile(rbac, 'utf8');
    if (!rules.includes(POD_LOG_RULE)) {
      throw new Error('charts/anycloud-api no longer has the pods/log rule');
    }
    await writeFile(rbac, rules.replace(POD_LOG_RULE, ''));
    // Before that fix the chart selected the label the Node sets itself.
    const valuesFile = path.join(olderDirectory, 'values.yaml');
    const values = await readFile(valuesFile, 'utf8');
    if (!values.includes(PROTECTED_SELECTOR)) {
      throw new Error(
        'charts/anycloud-api no longer selects the protected label',
      );
    }
    await writeFile(
      valuesFile,
      values.replace(PROTECTED_SELECTOR, 'anycloud.sh/cluster-management:'),
    );
    // The packaged archive, base64, as an inline `chartContent` holds it.
    const { stdout: older } = await inHelm({
      version,
      chartDirectory: olderDirectory,
      then: 'base64 "$CHART" | tr -d "\\n"',
    });
    const release = buildSystemReleaseHelmChart({
      installationId: 'e2e-hosted-chart',
      cluster: {
        name: 'e2e-hosted-chart',
        kubernetesIdentity: input.kubernetesIdentity,
        joinEndpoint: input.connection.server,
        certificateAuthorityData: input.connection.certificateAuthorityData,
        record: null,
      },
      revision: 1,
      operationId: 'op-e2e-hosted-chart',
      apiImage: pinnedApiImage(version, digest),
      apiVersion: version,
      ownerUsername: 'e2e',
      ownerUserId: '1',
      githubAppIds: [],
      apiUrl: `http://${SYSTEM_RELEASE_HELM_CHART_NAME}.${SYSTEM_RELEASE_NAMESPACE}`,
      chart: ownChart,
      helmJobImage: SYSTEM_RELEASE_HELM_JOB_IMAGE,
      backup: null,
      restoreFromBackup: false,
    });
    // Before 0.1.68 the chart was inline. The registry speaks plain HTTP; the
    // API keeps that field when it switches the chart, as it keeps every
    // field it does not own.
    const { chart: _published, ...inline } = release.spec;
    void _published;

    // What bootstrap provides on a management host: the namespace, the
    // management Node labels (the protected one from create or reconfigure)
    // and Traefik's IngressRoute kind. Node pool ingress has already
    // installed that kind on this cluster.
    await docker([
      'exec',
      container,
      'kubectl',
      'label',
      'node',
      container,
      'anycloud.sh/cluster-management=true',
      `${MANAGEMENT_MEMBER_LABEL}=true`,
    ]);
    for (const object of [
      {
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: { name: SYSTEM_RELEASE_NAMESPACE },
      },
      {
        apiVersion: 'apiextensions.k8s.io/v1',
        kind: 'CustomResourceDefinition',
        metadata: { name: 'ingressroutes.traefik.io' },
        spec: {
          group: 'traefik.io',
          scope: 'Namespaced',
          names: {
            kind: 'IngressRoute',
            plural: 'ingressroutes',
            singular: 'ingressroute',
          },
          versions: [
            {
              name: 'v1alpha1',
              served: true,
              storage: true,
              schema: {
                openAPIV3Schema: {
                  type: 'object',
                  'x-kubernetes-preserve-unknown-fields': true,
                },
              },
            },
          ],
        },
      },
      {
        ...release,
        spec: { ...inline, chartContent: older, plainHTTP: true },
      },
    ]) {
      await clients.objects.create(object).catch((error: unknown) => {
        const { code, body } = error as { code?: number; body?: unknown };
        if (
          object.kind === 'HelmChart' ||
          code !== 409 ||
          !String(body).includes('"reason":"AlreadyExists"')
        ) {
          throw error;
        }
      });
    }

    const readHelmChart = (): Promise<HelmChartObject> =>
      clients.objects.read({
        apiVersion: 'helm.cattle.io/v1',
        kind: 'HelmChart',
        metadata: {
          name: SYSTEM_RELEASE_HELM_CHART_NAME,
          namespace: SYSTEM_RELEASE_NAMESPACE,
        },
      });
    const readyJobSucceeded = () =>
      clients.objects
        .read({
          apiVersion: 'batch/v1',
          kind: 'Job',
          metadata: {
            name: readyJobName(1),
            namespace: SYSTEM_RELEASE_NAMESPACE,
          },
        })
        .then(
          (job) =>
            ((job as { status?: { succeeded?: number } }).status?.succeeded ??
              0) > 0,
          notFound,
        );
    const podLogAllowed = () =>
      clients.authorization
        .createSubjectAccessReview({
          body: {
            spec: {
              user: `system:serviceaccount:${SYSTEM_RELEASE_NAMESPACE}:${SYSTEM_RELEASE_HELM_CHART_NAME}`,
              resourceAttributes: {
                namespace: 'default',
                verb: 'get',
                resource: 'pods',
                subresource: 'log',
              },
            },
          },
        })
        .then((review) => review.status?.allowed === true);
    const apiPods = () =>
      clients.core
        .listNamespacedPod({
          namespace: SYSTEM_RELEASE_NAMESPACE,
          // The release's hook Job Pods carry the chart labels too.
          labelSelector: `app.kubernetes.io/name=${SYSTEM_RELEASE_HELM_CHART_NAME},!job-name`,
        })
        .then((pods) => pods.items);

    const ownChartInPlace = (chart: HelmChartObject) =>
      chart.spec.chart === ownChart && !chart.spec.chartContent;
    // Install (older chart), then the API's own Helm upgrade with its chart.
    const {
      moved: [first],
    } = await wait.for(
      'hosted API applies its own chart',
      async () => {
        const pods = await apiPods();
        for (const pod of pods) {
          for (const status of [
            ...(pod.status?.initContainerStatuses ?? []),
            ...(pod.status?.containerStatuses ?? []),
          ]) {
            const waiting = status.state?.waiting;
            if (
              /ErrImagePull|ImagePullBackOff|InvalidImageName/u.test(
                waiting?.reason ?? '',
              )
            ) {
              throw new Error(
                `API Pod ${pod.metadata?.name ?? ''} cannot pull ${status.image}: ${waiting?.reason ?? ''} ${waiting?.message ?? ''}`,
              );
            }
          }
        }
        return {
          switched: ownChartInPlace(await readHelmChart()),
          allowed: await podLogAllowed(),
          // The older chart selected the label the Node sets itself; the
          // API's Pod moves onto the protected one.
          moved: pods.filter(
            (pod) =>
              !pod.metadata?.deletionTimestamp &&
              pod.spec?.nodeSelector?.[MANAGEMENT_MEMBER_LABEL] === 'true' &&
              pod.spec.nodeName === container,
          ),
        };
      },
      {
        timeoutMs: 900_000,
        intervalMs: 5_000,
        probeError: 'fail',
        unmet: ({ switched, allowed, moved }) =>
          !switched
            ? 'HelmChart still carries the older inline chart'
            : !allowed
              ? 'anycloud-api cannot get pods/log yet'
              : moved.length === 1
                ? undefined
                : 'no API Pod on the protected management label yet',
      },
    );
    // No loop: after a settle period the upgrade's ready Job has succeeded,
    // the replacement Pod found its chart current and was never replaced.
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    await wait.for('hosted API chart upgrade ready', readyJobSucceeded, {
      timeoutMs: 300_000,
      intervalMs: 5_000,
      probeError: 'fail',
      unmet: (ready) => (ready ? undefined : 'ready Job has not succeeded'),
    });
    const pods = await apiPods();
    const [pod] = pods;
    const name = pod?.metadata?.name ?? '';
    const restarts = pod?.status?.containerStatuses?.find(
      (status) => status.name === 'api',
    )?.restartCount;
    const logs = name
      ? await clients.core.readNamespacedPodLog({
          name,
          namespace: SYSTEM_RELEASE_NAMESPACE,
          container: 'api',
        })
      : '';
    const applications = logs.split('API system chart applied').length - 1;
    if (
      pods.length !== 1 ||
      pod?.metadata?.uid !== first?.metadata?.uid ||
      restarts !== 0 ||
      applications !== 0 ||
      !ownChartInPlace(await readHelmChart())
    ) {
      throw new Error(
        `Hosted API did not settle after applying its chart: ${JSON.stringify({
          pods: pods.map((candidate) => candidate.metadata?.name),
          replaced: pod?.metadata?.uid !== first?.metadata?.uid,
          restarts,
          applications,
        })}`,
      );
    }
    return {
      chart: ownChart,
      podLogPermitted: true as const,
      apiPod: name,
      apiRestarts: 0 as const,
    };
  } catch (error) {
    // The cluster's own account of the release; the run log keeps it.
    const kubectl = async (...args: string[]) =>
      (
        await docker(['exec', container, 'kubectl', ...args]).catch(
          (failure: unknown) => ({ stdout: String(failure) }),
        )
      ).stdout;
    const ns = ['--namespace', SYSTEM_RELEASE_NAMESPACE];
    process.stderr.write(
      [
        await kubectl('get', 'helmchart,jobs,pods,pvc', '-o', 'wide', ...ns),
        await kubectl('describe', 'pods', ...ns),
        await kubectl(
          'logs',
          '--tail=60',
          '-l',
          'job-name=helm-install-anycloud-api',
          ...ns,
        ),
        await kubectl(
          'logs',
          '--tail=120',
          '--prefix',
          '-l',
          'app.kubernetes.io/name=anycloud-api,!job-name',
          '--all-containers',
          ...ns,
        ),
        await kubectl(
          'logs',
          '--tail=60',
          '--previous',
          '-l',
          'app.kubernetes.io/name=anycloud-api,!job-name',
          '-c',
          'api',
          ...ns,
        ),
        await kubectl('get', 'events', '--sort-by=.lastTimestamp', ...ns),
        (
          await docker([
            'exec',
            container,
            'ctr',
            '-n',
            'k8s.io',
            'images',
            'ls',
          ]).catch((failure: unknown) => ({ stdout: String(failure) }))
        ).stdout,
      ].join('\n---\n'),
    );
    throw error;
  } finally {
    await docker(['image', 'rm', '--force', tag]).catch(() => undefined);
    await docker(['rm', '--force', registry]).catch(() => undefined);
  }
}
