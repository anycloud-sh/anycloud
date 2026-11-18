import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { loadYaml } from '@kubernetes/client-node';
import { describe, expect, it } from 'vitest';

interface WorkflowStep {
  name?: string;
  if?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: {
    path?: string;
    'retention-days'?: number;
    'if-no-files-found'?: string;
  };
}

const workflow = loadYaml<{
  on: { workflow_dispatch: { inputs: Record<string, unknown> } };
  concurrency: { group: string; 'cancel-in-progress': boolean };
  jobs: Record<
    string,
    {
      if?: string;
      needs?: string[];
      'timeout-minutes'?: number;
      'continue-on-error'?: boolean;
      strategy?: { matrix: { provider: string } };
      concurrency?: {
        group: string;
        queue?: string;
        'cancel-in-progress'?: boolean;
      };
      permissions?: Record<string, string>;
      env: Record<string, string>;
      steps: WorkflowStep[];
    }
  >;
}>(readFileSync('.github/workflows/e2e-gpu.yml', 'utf8'));

const defaults = {
  provider: 'lambda',
  service_cleanup_audit: '',
  force_service_cleanup: false,
  mace_only: false,
  azure_ghcr_probe_only: false,
  vm_type: 'Standard_NC4as_T4_v3',
  region: 'westus2',
  disk_size: '100',
  disk_tier: 'high',
  spot: false,
  probe_image:
    'ghcr.io/anycloud-sh/mace@sha256:c60574d120937bd1db9c0c579d427f2b48d307f44c552888952354bf77c2d19d',
  sample_bytes: '268435456',
  ladder: '1 4 8 16',
  pull_concurrency: '3',
  pull_chunk_bytes: '134217728',
  force_job_cleanup: false,
  measure_baseline: false,
};

function evaluate(
  expression: string,
  inputs: Partial<typeof defaults>,
): unknown {
  // These actual YAML guards use the shared JavaScript/GitHub boolean subset.
  return runInNewContext(
    expression.replace(/^\$\{\{\s*|\s*\}\}$/gu, '').trim(),
    {
      inputs: { ...defaults, ...inputs },
      github: { ref: 'refs/heads/probe' },
      secrets: { LAMBDA_API_KEY: 'original-api-key' },
      always: () => true,
      cancelled: () => false,
      fromJSON: JSON.parse,
      format: (template: string, value: string) =>
        template.replace('{0}', value),
    },
  ) as unknown;
}

describe('direct VM MACE qualification workflow', () => {
  it('runs the Lambda sweep after the GPU cells under the shared provider lock', () => {
    const cleanup = workflow.jobs['post-cleanup-lambda'];
    expect(cleanup.needs).toEqual([
      'e2e-gpu-serve-vitest',
      'e2e-mace-vitest',
      'e2e-disk-tier-vitest',
    ]);
    expect(cleanup.concurrency?.group).toBe('e2e-gpu-qualification-lambda');
    expect(evaluate(workflow.concurrency.group, {})).toBe(
      'e2e-gpu-qualification-refs/heads/probe',
    );
    expect(workflow.concurrency['cancel-in-progress']).toBe(false);
  });

  it.each([
    [
      'ordinary Lambda',
      {},
      ['e2e-gpu-serve-vitest', 'e2e-mace-vitest', 'post-cleanup-lambda'],
    ],
    [
      'ordinary all-provider',
      { provider: 'all' },
      [
        'e2e-gpu-serve-vitest',
        'e2e-mace-vitest',
        'e2e-disk-tier-vitest',
        'post-cleanup-aws',
        'post-cleanup-azure',
        'post-cleanup-gcp',
        'post-cleanup-lambda',
      ],
    ],
    ['MACE only', { mace_only: true }, ['e2e-mace-vitest']],
    [
      'native audit',
      { service_cleanup_audit: '{"original":"scope"}' },
      ['service-native-audit'],
    ],
  ] as const)(
    'selects only the owned jobs for %s',
    (_name, inputs, expected) => {
      expect(
        Object.entries(workflow.jobs)
          .filter(([, job]) => evaluate(job.if!, inputs))
          .map(([name]) => name),
      ).toEqual(expected);
    },
  );

  it('preserves ordinary provider matrices', () => {
    const serve = workflow.jobs['e2e-gpu-serve-vitest'];
    expect(
      evaluate(serve.strategy!.matrix.provider, { provider: 'all' }),
    ).toEqual(['aws', 'azure', 'gcp', 'lambda']);
    expect(
      evaluate(serve.strategy!.matrix.provider, { provider: 'lambda' }),
    ).toEqual(['lambda']);
  });

  it('resolves scoped audit paths only after a runner is available and retains that exact output', () => {
    for (const job of Object.values(workflow.jobs)) {
      for (const value of Object.values(job.env)) {
        expect(value).not.toMatch(/\$\{\{[^}]*\brunner(?:\.|\[)/);
      }
    }
    const audit = workflow.jobs['service-native-audit'];
    const observe = audit.steps.find(
      (candidate) => candidate.run === 'yarn audit:service-cleanup',
    );
    const output = observe?.env?.SERVICE_CLEANUP_AUDIT_OUTPUT;
    expect(output).toBe('${{ runner.temp }}/service-cleanup-audit');
    const upload = audit.steps.find(
      (candidate) =>
        candidate.name === 'Retain successful and failed scoped observations',
    );
    expect(upload?.with?.path).toBe(`${output}/*.json`);
  });

  it('blocks on GPU Service cells, retains inner evidence, and sweeps every provider', () => {
    expect(
      workflow.on.workflow_dispatch.inputs.force_service_cleanup,
    ).toMatchObject({ type: 'boolean', default: false });
    const serveJob = workflow.jobs['e2e-gpu-serve-vitest'];
    expect(serveJob['continue-on-error']).toBe(false);
    expect(serveJob.concurrency).toEqual({
      group: 'e2e-gpu-qualification-${{ matrix.provider }}',
      queue: 'max',
      'cancel-in-progress': false,
    });
    expect(serveJob.env.E2E_SERVE_FORCE_FAILURE_BEFORE_FINALIZE).toContain(
      'inputs.force_service_cleanup',
    );
    const upload = serveJob.steps.find(
      (candidate) => candidate.name === 'Retain GPU Service evidence',
    );
    expect(upload?.if).toBe('always()');
    expect(upload?.with?.['retention-days']).toBeGreaterThanOrEqual(30);
    expect(upload?.with?.path).toContain(
      'vitest-fixture/**/fixture-record.json',
    );
    expect(upload?.with?.path).toContain('vitest-fixture/**/*native-*.json');
    expect(upload?.with?.path).toContain('vitest-fixture/**/*service-*.json');
    for (const provider of ['aws', 'azure', 'gcp', 'lambda']) {
      expect(workflow.jobs[`post-cleanup-${provider}`].needs).toEqual([
        'e2e-gpu-serve-vitest',
        'e2e-mace-vitest',
        'e2e-disk-tier-vitest',
      ]);
    }
  });
  it('makes MACE-only optional and excludes every smoke and provider sweep', () => {
    expect(workflow.on.workflow_dispatch.inputs.mace_only).toMatchObject({
      type: 'boolean',
      default: false,
    });
    for (const [name, job] of Object.entries(workflow.jobs)) {
      if (name.startsWith('azure-ghcr-probe')) {
        // The probe-only entrypoint rejects mixed modes before setup or auth.
        expect(evaluate(job.if!, { mace_only: true })).toBe(false);
      } else if (name === 'service-native-audit') {
        // The exclusive audit entrypoint rejects mixed MACE/fault inputs
        // before any read, while all provisioning jobs are excluded.
        expect(job.if).toBe(
          "${{ !inputs.azure_ghcr_probe_only && inputs.service_cleanup_audit != '' }}",
        );
      } else if (name !== 'e2e-mace-vitest') {
        expect(job.if, name).toContain('!inputs.mace_only');
      }
    }
  });

  it('requires the retired MACE Vitest candidate', () => {
    expect(workflow.jobs['e2e-mace-vitest']['continue-on-error']).toBe(false);
  });

  it.each([
    ['missing', undefined, false],
    ['outstanding workload', 'macefp-unfinished\n', false],
    ['completed tracked cleanup', '', true],
  ] as const)(
    'checks the actual cleanup gate for %s',
    (_name, ledger, passes) => {
      const root = mkdtempSync(join(tmpdir(), 'mace-cleanup-gate-'));
      try {
        if (ledger !== undefined) {
          writeFileSync(join(root, 'workloads-to-clean'), ledger);
        }
        const gate = {
          run: workflow.jobs['e2e-mace-vitest'].steps.find(
            (candidate) =>
              candidate.name === 'Require completed MACE Job tracked cleanup',
          )!.run!,
          variable: 'RESULTS_DIR',
        };
        const result = spawnSync('bash', ['-e', '-c', gate.run], {
          env: { ...process.env, [gate.variable]: root },
          encoding: 'utf8',
        });
        expect(result.status === 0, result.stderr).toBe(passes);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

describe('Azure GHCR probe-only routing', () => {
  // The Bash `azure-ghcr-probe` job is retired (RETIREMENT.md).
  const jobNames = ['azure-ghcr-probe-vitest'] as const;

  it('retains the twelve original typed inputs within the dispatch limit', () => {
    const inputs = workflow.on.workflow_dispatch.inputs;
    expect(Object.keys(inputs)).toHaveLength(17);
    expect(inputs.azure_ghcr_probe_only).toMatchObject({
      type: 'boolean',
      default: false,
    });
    for (const name of [
      'vm_type',
      'region',
      'disk_size',
      'probe_image',
      'sample_bytes',
      'ladder',
      'pull_concurrency',
      'pull_chunk_bytes',
    ] as const) {
      expect(inputs[name], name).toMatchObject({
        type: 'string',
        required: true,
        default: defaults[name],
      });
    }
    expect(inputs.disk_tier).toMatchObject({
      type: 'choice',
      required: true,
      options: ['high', 'medium', 'ultra'],
      default: 'high',
    });
    for (const name of ['spot', 'measure_baseline'] as const) {
      expect(inputs[name], name).toMatchObject({
        type: 'boolean',
        required: true,
        default: false,
      });
    }
    expect(inputs.force_job_cleanup).toMatchObject({
      type: 'boolean',
      default: false,
    });
  });

  it.each([
    {},
    { provider: 'all' },
    { mace_only: true },
    { service_cleanup_audit: '{"original":"scope"}' },
    { force_service_cleanup: true },
    { force_job_cleanup: true, measure_baseline: true },
  ])(
    'excludes all other jobs when Azure probe-only is selected: %j',
    (inputs) => {
      const selected = {
        provider: 'azure',
        ...inputs,
        azure_ghcr_probe_only: true,
      };
      expect(
        Object.entries(workflow.jobs)
          .filter(([, job]) => evaluate(job.if!, selected))
          .map(([name]) => name),
      ).toEqual(jobNames);
      expect(evaluate(workflow.concurrency.group, selected)).toBe(
        'e2e-azure-ghcr-probe-refs/heads/probe',
      );
    },
  );

  it('keeps the ordinary Azure qualification graph with its MACE Job consumer', () => {
    expect(
      Object.entries(workflow.jobs)
        .filter(([, job]) => evaluate(job.if!, { provider: 'azure' }))
        .map(([name]) => name),
    ).toEqual([
      'e2e-gpu-serve-vitest',
      'e2e-mace-vitest',
      'post-cleanup-azure',
    ]);
  });

  describe.each(jobNames)('%s', (jobName) => {
    const job = workflow.jobs[jobName];
    const guard = job.steps.find(
      (candidate) => candidate.name === 'Validate Azure probe-only selection',
    )!;
    const profile = (inputs: Partial<typeof defaults>) =>
      Object.fromEntries(
        Object.entries(job.env)
          .filter(([name]) => /^(?:PROBE_|E2E_)/u.test(name))
          .map(([name, value]) => [name, String(evaluate(value, inputs))]),
      );

    it.each([
      [{}, true],
      [{ force_job_cleanup: true, measure_baseline: true }, true],
      [{ provider: 'all' }, false],
      [{ provider: 'lambda' }, false],
      [{ mace_only: true }, false],
      [{ service_cleanup_audit: '{"original":"scope"}' }, false],
      [{ force_service_cleanup: true }, false],
    ] as const)('runs the actual pre-setup guard for %j', (inputs, passes) => {
      const selected = {
        provider: 'azure',
        azure_ghcr_probe_only: true,
        ...inputs,
      };
      const environment = Object.fromEntries(
        Object.entries(guard.env!).map(([name, value]) => [
          name,
          String(evaluate(value, selected)),
        ]),
      );
      const result = spawnSync('bash', ['-e', '-c', guard.run!], {
        env: { ...process.env, ...environment },
        encoding: 'utf8',
      });
      expect(result.status === 0, result.stderr).toBe(passes);
      if (!passes) expect(result.stderr).toContain('requires provider=azure');
    });

    it('forwards the real default and explicit profiles with the original deadlines', () => {
      expect(profile({})).toEqual({
        E2E_JOB_FORCE_CLEANUP: '',
        E2E_TEST_TIMEOUT_SECONDS: '3600',
        PROBE_IMAGE: defaults.probe_image,
        PROBE_VM_TYPE: 'Standard_NC4as_T4_v3',
        PROBE_REGION: 'westus2',
        PROBE_DISK_SIZE: '100',
        PROBE_DISK_TIER: 'high',
        PROBE_SPOT: 'false',
        PROBE_SAMPLE_BYTES: '268435456',
        PROBE_LADDER: '1 4 8 16',
        PROBE_PULL_CONCURRENCY: '3',
        PROBE_PULL_CHUNK_BYTES: '134217728',
        PROBE_MEASURE_BASELINE: '0',
      });
      expect(
        profile({
          force_job_cleanup: true,
          measure_baseline: true,
          vm_type: 'Standard_NC8as_T4_v3',
          region: 'eastus',
          disk_size: '200',
          disk_tier: 'medium',
          spot: true,
          probe_image: `ghcr.io/anycloud-sh/mace@sha256:${'a'.repeat(64)}`,
          sample_bytes: '536870912',
          ladder: '2 4',
          pull_concurrency: '4',
          pull_chunk_bytes: '67108864',
        }),
      ).toEqual({
        E2E_JOB_FORCE_CLEANUP: '1',
        E2E_TEST_TIMEOUT_SECONDS: '5400',
        PROBE_IMAGE: `ghcr.io/anycloud-sh/mace@sha256:${'a'.repeat(64)}`,
        PROBE_VM_TYPE: 'Standard_NC8as_T4_v3',
        PROBE_REGION: 'eastus',
        PROBE_DISK_SIZE: '200',
        PROBE_DISK_TIER: 'medium',
        PROBE_SPOT: 'true',
        PROBE_SAMPLE_BYTES: '536870912',
        PROBE_LADDER: '2 4',
        PROBE_PULL_CONCURRENCY: '4',
        PROBE_PULL_CHUNK_BYTES: '67108864',
        PROBE_MEASURE_BASELINE: '1',
      });
    });

    it('preserves the actual probe entrypoint, provider lock, authority and retained cleanup', () => {
      expect(job.concurrency).toEqual({
        group: 'e2e-gpu-qualification-azure',
        queue: 'max',
        'cancel-in-progress': false,
      });
      expect(job['timeout-minutes']).toBe(120);
      expect(job['continue-on-error']).toBe(false);
      expect(job.permissions).toEqual({ contents: 'read', packages: 'read' });
      expect(job.env.AZURE_SUBSCRIPTION_ID).toBe(
        '${{ secrets.AZURE_SUBSCRIPTION_ID }}',
      );
      expect(job.env.AZURE_TENANT_ID).toBe(
        '${{ secrets.AZURE_DIRECTORY_ID || secrets.AZURE_TENANT_ID }}',
      );
      expect(job.env.AZURE_CLIENT_ID).toBe(
        '${{ secrets.AZURE_APPLICATION_ID || secrets.AZURE_CLIENT_ID }}',
      );
      expect(job.env.AZURE_CLIENT_SECRET).toBe(
        '${{ secrets.AZURE_SECRET || secrets.AZURE_CLIENT_SECRET }}',
      );
      const capability = job.steps.findIndex(
        (candidate) =>
          candidate.run ===
          './test/integration/probe-containerd-parallel-pull.sh --self-test',
      );
      expect(capability).toBeGreaterThan(job.steps.indexOf(guard));
      for (const stepName of ['Setup Node.js 22', 'Log in to GHCR']) {
        expect(
          job.steps.findIndex((candidate) => candidate.name === stepName),
        ).toBeGreaterThan(capability);
      }
      expect(
        job.steps.find((candidate) => candidate.run?.includes('e2e.sh'))?.run,
      ).toBe(
        'git rev-parse HEAD > /tmp/job-comparison-source-sha.txt\n' +
          './test/integration/e2e.sh azure-ghcr-probe --vitest\n',
      );
      const uploads = job.steps.filter(
        (candidate) => candidate.uses === 'actions/upload-artifact@v4',
      );
      expect(uploads).toHaveLength(2);
      expect(uploads[0]).toMatchObject({
        if: 'always()',
        with: { 'retention-days': 30, 'if-no-files-found': 'error' },
      });
      expect(uploads[0].with?.path).toContain('workloads-to-clean');
      expect(uploads[0].with?.path).toContain(
        'vitest-fixture/**/cleanup-observations.json',
      );
      expect(uploads[1].with?.['retention-days']).toBe(3);
    });
  });
});
