import { KubernetesObjectApi, PatchStrategy } from '@kubernetes/client-node';
import {
  kubeConfigFromClusterConnection,
  type ClusterConnectionDocument,
} from './kubernetes/cluster-connection.js';
import type { ClusterReleaseClient } from './system-release-domain.js';
import { ClusterReleaseConflictError } from './cluster-errors.js';
import type { HelmChartObject } from '../../shared/system-release-values.js';

/** The system release's Kubernetes client, through the cluster's stored connection. */
export function createClusterReleaseClient(): ClusterReleaseClient {
  const objects = (connection: ClusterConnectionDocument) =>
    KubernetesObjectApi.makeApiClient(
      kubeConfigFromClusterConnection(connection),
    );
  return {
    async applyObject(connection, object) {
      const client = objects(connection);
      try {
        await client.create(object);
      } catch (error) {
        if ((error as { code?: number }).code !== 409) throw error;
        await client.patch(
          object,
          undefined,
          undefined,
          undefined,
          undefined,
          PatchStrategy.MergePatch,
        );
      }
    },
    async getHelmChart(connection, name, namespace) {
      try {
        const object = await objects(connection).read({
          apiVersion: 'helm.cattle.io/v1',
          kind: 'HelmChart',
          metadata: { name, namespace },
        });
        return object as unknown as HelmChartObject;
      } catch (error) {
        if ((error as { code?: number }).code === 404) return null;
        throw error;
      }
    },
    async applyHelmChart(connection, chart, expectedResourceVersion) {
      const client = objects(connection);
      try {
        if (expectedResourceVersion === null) {
          await client.create(chart);
          return;
        }
        // The observed resourceVersion is the precondition: the API server
        // answers 409 when the object moved since the comparison.
        await client.patch(
          {
            ...chart,
            metadata: {
              ...chart.metadata,
              resourceVersion: expectedResourceVersion,
            },
          },
          undefined,
          undefined,
          undefined,
          undefined,
          PatchStrategy.MergePatch,
        );
      } catch (error) {
        if ((error as { code?: number }).code === 409) {
          throw new ClusterReleaseConflictError();
        }
        throw error;
      }
    },
  };
}
