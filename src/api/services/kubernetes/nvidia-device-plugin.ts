import type {
  V1Container,
  V1DaemonSet,
  V1Toleration,
  V1Volume,
} from '@kubernetes/client-node';

export const NVIDIA_GPU_RESOURCE = 'nvidia.com/gpu';
export const NVIDIA_RUNTIME_CLASS = 'nvidia';
export const NVIDIA_DEVICE_PLUGIN_NAME = 'anycloud-nvidia-device-plugin';

// NVIDIA v0.18.2, including amd64 and arm64; verified against nvcr.io.
// https://github.com/NVIDIA/k8s-device-plugin/tree/v0.18.2/workloads/static
export const NVIDIA_DEVICE_PLUGIN_IMAGE =
  'nvcr.io/nvidia/k8s-device-plugin@sha256:b5788e29e7ae5272de8de863ebe386d6611e608421a6ecc5b4e7d5952aba637f';

export interface DevicePluginDaemonSetOptions {
  name: string;
  /** Ownership labels; also the Pod selector, so they must be stable. */
  labels: Record<string, string>;
  /** Exactly the Nodes that carry the devices this owner manages. */
  nodeSelector: Record<string, string>;
  /** Taints those Nodes carry; never the management taint. */
  tolerations?: V1Toleration[];
  runtimeClassName?: string;
  /** The plugin; it gets the kubelet's device-plugin socket directory. */
  container: V1Container;
  volumes?: V1Volume[];
}

const DEVICE_PLUGINS = {
  name: 'device-plugins',
  path: '/var/lib/kubelet/device-plugins',
};

/**
 * One DaemonSet shape for every device plugin. A plugin advertises
 * allocatable devices per Node through the kubelet device-plugin socket; it
 * never touches Pods, so it needs no service-account token.
 */
export function buildDevicePluginDaemonSet(
  options: DevicePluginDaemonSetOptions,
): V1DaemonSet {
  const { labels, container } = options;
  return {
    apiVersion: 'apps/v1',
    kind: 'DaemonSet',
    metadata: { name: options.name, namespace: 'kube-system', labels },
    spec: {
      selector: { matchLabels: labels },
      updateStrategy: { type: 'RollingUpdate' },
      template: {
        metadata: { labels },
        spec: {
          automountServiceAccountToken: false,
          ...(options.runtimeClassName && {
            runtimeClassName: options.runtimeClassName,
          }),
          priorityClassName: 'system-node-critical',
          nodeSelector: options.nodeSelector,
          tolerations: options.tolerations,
          containers: [
            {
              ...container,
              volumeMounts: [
                { name: DEVICE_PLUGINS.name, mountPath: DEVICE_PLUGINS.path },
                ...(container.volumeMounts ?? []),
              ],
            },
          ],
          volumes: [
            {
              name: DEVICE_PLUGINS.name,
              hostPath: { path: DEVICE_PLUGINS.path, type: 'Directory' },
            },
            ...(options.volumes ?? []),
          ],
        },
      },
    },
  };
}

/** NVIDIA's plugin, which needs no capabilities. */
export function buildNvidiaDevicePluginDaemonSet(
  options: Pick<
    DevicePluginDaemonSetOptions,
    'labels' | 'nodeSelector' | 'tolerations'
  >,
): V1DaemonSet {
  return buildDevicePluginDaemonSet({
    ...options,
    name: NVIDIA_DEVICE_PLUGIN_NAME,
    runtimeClassName: NVIDIA_RUNTIME_CLASS,
    tolerations: [
      { key: NVIDIA_GPU_RESOURCE, operator: 'Exists', effect: 'NoSchedule' },
      ...(options.tolerations ?? []),
    ],
    container: {
      name: 'nvidia-device-plugin',
      image: NVIDIA_DEVICE_PLUGIN_IMAGE,
      env: [
        { name: 'FAIL_ON_INIT_ERROR', value: 'true' },
        { name: 'MIG_STRATEGY', value: 'none' },
        { name: 'DEVICE_LIST_STRATEGY', value: 'envvar' },
        { name: 'NVIDIA_VISIBLE_DEVICES', value: 'all' },
        { name: 'NVIDIA_DRIVER_CAPABILITIES', value: 'compute,utility' },
      ],
      securityContext: {
        allowPrivilegeEscalation: false,
        capabilities: { drop: ['ALL'] },
      },
    },
  });
}

export function buildNvidiaDevicePlugin(clusterId: string): V1DaemonSet {
  return buildNvidiaDevicePluginDaemonSet({
    labels: {
      'app.kubernetes.io/name': NVIDIA_DEVICE_PLUGIN_NAME,
      'app.kubernetes.io/managed-by': 'anycloud',
      'anycloud.sh/cluster-id': clusterId,
    },
    // Managed capacity uses one NVIDIA VM type. Its existing cluster
    // label also selects Nodes created before GPU plugin support.
    nodeSelector: { 'anycloud.sh/cluster-id': clusterId },
  });
}
