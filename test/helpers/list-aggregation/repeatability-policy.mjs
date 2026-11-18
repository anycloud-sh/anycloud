import { POLICY } from './protocol.mjs';
import { FIXTURE_STORAGE } from './fixture-storage.mjs';

export const REPEATABILITY = {
  id: 'list-fixture-preflight-v2',
  replacesInvalidStudy: 'list-fixture-preflight-v1 (hosted disk exhaustion)',
  application: '913f8e992adbefd8d236d59fcec89f99dd788503',
  candidatePatchSha256:
    '36949d4347621af7fc7c2b4a899a6b44019a1cbbdccd0a3424b8abb3ff302f50',
  node: 'v22.14.0',
  driver: '11.10.0',
  sqlite: '3.49.2',
  executionBudgetMs: 1_800_000,
  childBudgetMs: 180_000,
  settleMs: 30_000,
  scope: 'user',
  profile: 'mixed',
  counts: { workloads: 18664, vms: 285564, workload_events: 1994751 },
  endpoints: [
    'ordinary-1000',
    'terminatable-1000',
    'daily-cost',
    'terminal-status',
  ],
  setupTrials: [
    { id: 'setup-original', proof: false },
    { id: 'setup-file-proof', proof: true },
    { id: 'setup-reversal', proof: false },
  ],
  setupSamples: 3,
  setupWarmups: 2,
  warmups: 10,
  samples: 50,
  repetitions: 6,
  policy: POLICY,
  storage: FIXTURE_STORAGE,
  promotion: false,
  runner: 'one fresh ubuntu-24.04 GitHub-hosted job; sequential trials',
  stop: 'A/A failure stops before A/B; no replacements or extra repetitions',
};

export function repeatabilityDefinition() {
  return {
    id: REPEATABILITY.id,
    mode: 'matrix',
    samples: REPEATABILITY.samples,
    metrics: REPEATABILITY.endpoints.flatMap((endpoint) =>
      ['sqlMeanMs', 'httpP50Ms', 'httpP95Ms'].map((metric) => ({
        id: endpoint + '/' + metric,
        type: 'ratio',
        primary:
          metric === 'sqlMeanMs' &&
          ['ordinary-1000', 'terminatable-1000'].includes(endpoint),
      })),
    ),
  };
}

export function pairedTrialOrder(stage) {
  return Array.from({ length: REPEATABILITY.repetitions }, (_, i) => {
    const arms = i % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
    return arms.map((arm) => ({
      id: `${stage}-${i + 1}-${arm}`,
      stage,
      repetition: i + 1,
      arm,
    }));
  }).flat();
}
