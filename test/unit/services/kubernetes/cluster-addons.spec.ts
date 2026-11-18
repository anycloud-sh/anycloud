import { describe, expect, it } from 'vitest';
import type {
  V1RuntimeClass,
  V1ValidatingAdmissionPolicy,
  V1ValidatingAdmissionPolicyBinding,
} from '@kubernetes/client-node';
import {
  buildNvidiaDevicePlugin,
  NVIDIA_DEVICE_PLUGIN_IMAGE,
} from '../../../../src/api/services/kubernetes/nvidia-device-plugin.js';
import {
  MANAGEMENT_TAINT_KEY,
  nodePoolNodeLabels,
} from '../../../../src/api/services/kubernetes/node-pool-scheduling.js';
import {
  buildClusterNvidiaDevicePlugin,
  buildClusterNvidiaRuntimeClass,
  buildNodeStatusPolicy,
  NVIDIA_CLUSTER_ADDON,
  NODE_STATUS_CLUSTER_ADDON,
  NODE_STATUS_POLICY_NAME,
  CLUSTER_ADDONS,
  buildKvmDevicePlugin,
  KVM_CLUSTER_ADDON,
  USER_NAMESPACE_CLUSTER_ADDON,
  clusterAddonPermissions,
  clusterAddonRevision,
} from '../../../../src/api/services/kubernetes/cluster-addons.js';
import { CloudType } from '../../../../src/shared/cloud.js';

describe('cluster add-on registry', () => {
  it('lists the NVIDIA stack, the user-namespace guard and class, KVM and the pool ingress release, each needed by its own pools, and the Node status policy every pool needs', () => {
    expect(CLUSTER_ADDONS.map((addon) => addon.name)).toEqual([
      'nvidia',
      'user-namespace',
      'kvm',
      'pool-ingress',
      'node-status',
    ]);
    expect(NODE_STATUS_CLUSTER_ADDON.neededBy({ nvidiaGpus: 0 })).toBe(true);
    expect(NVIDIA_CLUSTER_ADDON.neededBy({ nvidiaGpus: 0 })).toBe(false);
    expect(NVIDIA_CLUSTER_ADDON.neededBy({ nvidiaGpus: 1 })).toBe(true);
    expect(
      NVIDIA_CLUSTER_ADDON.resources('cluster-a').map((resource) => [
        resource.kind,
        resource.namespace ?? null,
        resource.name,
      ]),
    ).toEqual([
      ['RuntimeClass', null, 'nvidia'],
      ['DaemonSet', 'kube-system', 'anycloud-nvidia-device-plugin'],
    ]);
  });

  it('declares the RBAC delta the registered identity needs, deduplicated', () => {
    expect(clusterAddonPermissions().map((rule) => rule.label)).toEqual([
      'get runtimeclasses',
      'create runtimeclasses',
      'update runtimeclasses',
      'delete runtimeclasses',
      'get daemonsets in kube-system',
      'create daemonsets in kube-system',
      'update daemonsets in kube-system',
      'delete daemonsets in kube-system',
      'get validatingadmissionpolicies',
      'create validatingadmissionpolicies',
      'update validatingadmissionpolicies',
      'delete validatingadmissionpolicies',
      'get validatingadmissionpolicybindings',
      'create validatingadmissionpolicybindings',
      'update validatingadmissionpolicybindings',
      'delete validatingadmissionpolicybindings',
      'get helmcharts in kube-system',
      'create helmcharts in kube-system',
      'update helmcharts in kube-system',
      'delete helmcharts in kube-system',
    ]);
    expect(
      clusterAddonPermissions().every(
        (rule) =>
          (rule.group === 'node.k8s.io' && rule.namespace === undefined) ||
          (rule.group === 'apps' && rule.namespace === 'kube-system') ||
          (rule.group === 'helm.cattle.io' &&
            rule.namespace === 'kube-system') ||
          (rule.group === 'admissionregistration.k8s.io' &&
            rule.namespace === undefined),
      ),
    ).toBe(true);
  });

  it('declares every verb the reconciler may use on each object it manages', () => {
    const need = {
      nvidiaGpus: 1,
      ingressNodePoolId: 'pool-a',
      userNamespace: true,
      kvm: true,
    };
    for (const addon of CLUSTER_ADDONS) {
      for (const resource of addon.resources('cluster-a', need)) {
        const group = resource.apiVersion.split('/')[0];
        for (const verb of ['get', 'create', 'update', 'delete']) {
          expect(
            addon.permissions.find(
              (rule) =>
                rule.verb === verb &&
                rule.group === group &&
                rule.resource === resource.apiResource &&
                rule.namespace === resource.namespace,
            ),
            `${addon.name}: ${verb} ${resource.apiResource}`,
          ).toBeDefined();
        }
      }
    }
  });

  it("selects exactly this cluster's GPU node pool Nodes and never the management Node", () => {
    const daemonSet = buildClusterNvidiaDevicePlugin('cluster-a');
    const podSpec = daemonSet.spec!.template.spec!;
    expect(podSpec.nodeSelector).toEqual({
      'anycloud.sh/cluster': 'cluster-a',
      'anycloud.sh/accelerator': 'nvidia',
    });
    expect(podSpec.tolerations).toEqual([
      { key: 'nvidia.com/gpu', operator: 'Exists', effect: 'NoSchedule' },
      {
        key: 'anycloud.sh/node-pool',
        operator: 'Exists',
        effect: 'NoSchedule',
      },
    ]);
    expect(
      podSpec.tolerations!.some(
        (toleration) =>
          !toleration.key || toleration.key === MANAGEMENT_TAINT_KEY,
      ),
    ).toBe(false);
    expect(podSpec.containers[0].image).toBe(NVIDIA_DEVICE_PLUGIN_IMAGE);
    expect(NVIDIA_DEVICE_PLUGIN_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(podSpec.automountServiceAccountToken).toBe(false);
    expect(podSpec.runtimeClassName).toBe('nvidia');
    expect(daemonSet.metadata?.labels).toEqual(
      daemonSet.spec!.selector.matchLabels,
    );
    expect(daemonSet.metadata?.labels).toEqual({
      'app.kubernetes.io/name': 'anycloud-nvidia-device-plugin',
      'app.kubernetes.io/managed-by': 'anycloud',
      'anycloud.sh/cluster': 'cluster-a',
      'anycloud.sh/addon': 'nvidia',
    });

    // A GPU node pool Node matches the selector; CPU and management do not.
    const gpuNode = nodePoolNodeLabels({
      clusterId: 'cluster-a',
      nodePoolId: 'p',
      cloudProvider: CloudType.AWS,
      vmRowId: 1,
      accelerator: 'nvidia',
    });
    const cpuNode = nodePoolNodeLabels({
      clusterId: 'cluster-a',
      nodePoolId: 'p',
      cloudProvider: CloudType.AWS,
      vmRowId: 2,
    });
    const matches = (labels: Record<string, string>) =>
      Object.entries(podSpec.nodeSelector!).every(
        ([key, value]) => labels[key] === value,
      );
    expect(matches(gpuNode)).toBe(true);
    expect(matches(cpuNode)).toBe(false);
    expect(matches({ 'anycloud.sh/cluster': 'cluster-a' })).toBe(false);
    expect(matches({ ...gpuNode, 'anycloud.sh/cluster': 'cluster-b' })).toBe(
      false,
    );

    // The managed-cluster variant is unchanged apart from its selector.
    const cluster = buildNvidiaDevicePlugin('training-1');
    expect(cluster.spec!.template.spec!.nodeSelector).toEqual({
      'anycloud.sh/cluster-id': 'training-1',
    });
    expect(cluster.spec!.template.spec!.containers).toEqual(podSpec.containers);
  });

  it('builds a RuntimeClass owned by the cluster with the nvidia handler and no overrides', () => {
    expect(buildClusterNvidiaRuntimeClass('cluster-a')).toEqual({
      apiVersion: 'node.k8s.io/v1',
      kind: 'RuntimeClass',
      metadata: {
        name: 'nvidia',
        labels: {
          'app.kubernetes.io/name': 'anycloud-nvidia-runtime',
          'app.kubernetes.io/managed-by': 'anycloud',
          'anycloud.sh/cluster': 'cluster-a',
          'anycloud.sh/addon': 'nvidia',
        },
      },
      handler: 'nvidia',
    });
  });

  it('RFC 0049 C32 guards the user-namespace class with a policy listed before it, and gives KVM to its Nodes only', () => {
    expect(USER_NAMESPACE_CLUSTER_ADDON.neededBy({ nvidiaGpus: 0 })).toBe(
      false,
    );
    expect(
      KVM_CLUSTER_ADDON.neededBy({ nvidiaGpus: 0, userNamespace: true }),
    ).toBe(false);
    const resources = USER_NAMESPACE_CLUSTER_ADDON.resources('cluster-a');
    expect(resources.map(({ kind, name }) => [kind, name])).toEqual([
      ['ValidatingAdmissionPolicy', 'anycloud-user-namespace'],
      ['ValidatingAdmissionPolicyBinding', 'anycloud-user-namespace'],
      ['RuntimeClass', 'anycloud-user-namespace'],
    ]);
    const [policy, binding, runtimeClass] = resources.map(
      ({ desired }) => desired,
    ) as [
      V1ValidatingAdmissionPolicy,
      V1ValidatingAdmissionPolicyBinding,
      V1RuntimeClass,
    ];
    expect(policy.spec!.matchConstraints!.resourceRules).toEqual([
      expect.objectContaining({
        operations: ['CREATE', 'UPDATE'],
        resources: ['pods', 'pods/ephemeralcontainers'],
      }),
    ]);
    expect(policy.spec!.matchConditions![0]!.expression).toContain(
      "object.spec.runtimeClassName == 'anycloud-user-namespace'",
    );
    expect(policy.spec!.validations!.map((v) => v.expression)).toEqual([
      'has(object.spec.hostUsers) && object.spec.hostUsers == false',
      ...['containers', 'initContainers', 'ephemeralContainers'].map(
        (list) =>
          `!has(object.spec.${list}) || object.spec.${list}.all(c, !has(c.securityContext) || !has(c.securityContext.privileged) || !c.securityContext.privileged)`,
      ),
    ]);
    expect(binding.spec).toEqual({
      policyName: 'anycloud-user-namespace',
      validationActions: ['Deny'],
    });
    expect(runtimeClass).toMatchObject({
      handler: 'anycloud-userns',
      overhead: { podFixed: { memory: '32Mi' } },
      scheduling: {
        nodeSelector: {
          'node-restriction.kubernetes.io/anycloud-user-namespace': 'true',
        },
      },
    });
    // Handler, overhead and scheduling are immutable: any difference recreates.
    const recreate = resources[2]!.requiresRecreate as (
      current: V1RuntimeClass,
    ) => boolean;
    expect(recreate(runtimeClass)).toBe(false);
    expect(recreate({ ...runtimeClass, overhead: undefined })).toBe(true);
    const plugin = buildKvmDevicePlugin('cluster-a').spec!.template.spec!;
    expect(plugin.nodeSelector).toEqual({
      'anycloud.sh/cluster': 'cluster-a',
      'node-restriction.kubernetes.io/anycloud-user-namespace': 'true',
    });
    expect(plugin.tolerations).toEqual([
      {
        key: 'anycloud.sh/node-pool',
        operator: 'Exists',
        effect: 'NoSchedule',
      },
    ]);
    expect(plugin.containers[0]!.args).toEqual([
      '--domain',
      'anycloud.sh',
      '--device',
      '{"name":"kvm","groups":[{"count":110,"paths":[{"path":"/dev/kvm"}]}]}',
    ]);
  });

  it("binds a denying policy to K3s's shared controller identity's Node status writes only", () => {
    const [policy, binding] = NODE_STATUS_CLUSTER_ADDON.resources('cluster-a');
    const built = buildNodeStatusPolicy('cluster-a');
    expect(policy!.desired).toEqual(built.policy);
    const spec = built.policy.spec;
    expect(spec.matchConstraints.resourceRules).toEqual([
      {
        apiGroups: [''],
        apiVersions: ['v1'],
        operations: ['UPDATE'],
        resources: ['nodes/status'],
      },
    ]);
    // Kubelets stay under NodeRestriction; only the shared identity matches.
    expect(spec.matchConditions).toEqual([
      {
        name: 'k3s-controller',
        expression: "request.userInfo.username == 'system:k3s-controller'",
      },
    ]);
    expect(spec.failurePolicy).toBe('Fail');
    expect(spec.validations).toHaveLength(1);
    expect(binding!.desired).toMatchObject({
      kind: 'ValidatingAdmissionPolicyBinding',
      metadata: {
        name: NODE_STATUS_POLICY_NAME,
        labels: { 'anycloud.sh/cluster': 'cluster-a' },
      },
      spec: {
        policyName: NODE_STATUS_POLICY_NAME,
        validationActions: ['Deny'],
      },
    });
    expect(binding!.desired).not.toHaveProperty('spec.matchResources');
  });

  it('fingerprints desired objects independent of key order and undefined fields', () => {
    const a = clusterAddonRevision({
      apiVersion: 'v1',
      kind: 'X',
      metadata: { name: 'n', labels: { b: '2', a: '1' } },
    });
    const b = clusterAddonRevision({
      kind: 'X',
      metadata: { labels: { a: '1', b: '2' }, name: 'n', namespace: undefined },
      apiVersion: 'v1',
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(
      clusterAddonRevision(buildClusterNvidiaDevicePlugin('cluster-a')),
    ).not.toBe(
      clusterAddonRevision(buildClusterNvidiaDevicePlugin('cluster-b')),
    );
  });
});
