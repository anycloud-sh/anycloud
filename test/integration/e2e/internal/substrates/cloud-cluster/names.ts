/**
 * The cluster name this member always creates: `e2e-cluster-<run id>`. The
 * product derives the installation id from the first nine characters of that
 * name (`id-generator.ts`), so the id, the managed checkpoint bucket named
 * after it and the `<id>.anycloud.sh` record all start with `e2e-clust-`.
 * Every sweep — here and in `.github/workflows/e2e-cluster-cloud.yml` — matches
 * the derived prefix; `test/unit/e2e-cloud-cluster-substrate.spec.ts` derives it
 * through the real generator so the two cannot drift.
 */
export const E2E_CLUSTER_NAME_PREFIX = 'e2e-cluster';
export const E2E_CLUSTER_ID_PREFIX = 'e2e-clust';
