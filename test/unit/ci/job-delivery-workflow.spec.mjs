import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadYaml } from '@kubernetes/client-node';
import { describe, expect, it } from 'vitest';

const workflow = loadYaml(
  readFileSync('.github/workflows/e2e-job.yml', 'utf8'),
);
const candidate = workflow.jobs['e2e-job-vitest'];
const integration = loadYaml(
  readFileSync('.github/workflows/integration.yml', 'utf8'),
);
const manualRecovery = loadYaml(
  readFileSync('.github/workflows/managed-gpu-recovery.yml', 'utf8'),
);

const retirementTable = readFileSync(
  'test/integration/e2e/RETIREMENT.md',
  'utf8',
);
/** Status column of the RETIREMENT.md row whose Candidate cell is `candidate`. */
function retirementStatus(candidate) {
  const row = retirementTable
    .split('\n')
    .find((line) => line.includes(`| \`${candidate}\` `));
  if (!row) throw new Error(`RETIREMENT.md has no row for ${candidate}`);
  return row
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim())[6];
}

/** Vitest member names in e2e-job.yml order. */
const JOB_ORDER = [
  'aws-bucket-sync',
  'azure-bucket-sync',
  'gcp-bucket-sync',
  'lambda-bucket-sync',
  'aws-concurrent-output',
  'azure-concurrent-output',
  'gcp-concurrent-output',
  'aws-job-host-unreachable',
  'azure-job-host-unreachable',
  'gcp-job-host-unreachable',
  'aws-input-hydration-recovery',
  'aws-spot-request-cleanup',
  'aws-runtime-secrets',
];
/** Members written in Vitest, with no Bash twin to retire. */
const VITEST_ONLY = [
  'aws-bucket-access-denied',
  'azure-bucket-access-denied',
  'gcp-bucket-access-denied',
  'aws-storage-tokens',
  'azure-storage-tokens',
  'gcp-storage-tokens',
  'aws-spot-eviction',
  'azure-spot-eviction',
  'gcp-spot-eviction',
  'azure-gpu-spot-eviction',
  'aws-gpu-probe-rerun',
  'azure-gpu-probe-rerun',
  'gcp-gpu-probe-rerun',
  'lambda-gpu-probe-rerun',
  'aws-restricted-credential',
  'azure-restricted-credential',
  'aws-host-docker',
  'azure-host-docker',
  'gcp-host-docker',
  'aws-arm64',
  'gcp-arm64',
  'azure-runtime-secrets',
  'gcp-runtime-secrets',
  'lambda-runtime-secrets',
];
const retired = (test) =>
  retirementStatus(`e2e.sh ${test} --vitest`) === 'retired';

describe('Job delivery workflow', () => {
  it('runs the admission candidates as required cells now that their Bash twins retired', () => {
    const job = integration.jobs['e2e-noprovision'];
    const targets = ['aws', 'azure', 'gcp'];
    for (const member of [
      ...targets.map((target) => `${target}-invalid`),
      'image-preflight-invalid',
    ])
      expect(retired(member), member).toBe(true);
    expect(job.strategy.matrix).toEqual({
      include: targets.map((target) => ({
        test: `${target}-invalid`,
        runner: 'vitest',
        args: '--vitest',
      })),
    });
    expect(job['continue-on-error']).toBeUndefined();
    expect(job.strategy['fail-fast']).toBe(false);
    expect(job['timeout-minutes']).toBe(30);
    expect(job.env).not.toHaveProperty('E2E_JOB_FORCE_CLEANUP');
    expect(job.steps.find((step) => step.id === 'tests')).toMatchObject({
      run: 'git rev-parse HEAD > /tmp/job-comparison-source-sha.txt\n./test/integration/e2e.sh ${{ matrix.test }} ${{ matrix.args }}\n',
    });
    const retained = job.steps.find(
      (step) => step.name === 'Retain Job admission comparison evidence',
    );
    expect(retained.if).toBe('always()');
    expect(retained.with['retention-days']).toBe(30);
    expect(retained.with['if-no-files-found']).toBe('error');
    expect(retained.with.name).toBe(
      'job-comparison-evidence-admission-${{ matrix.test }}-${{ matrix.runner }}-${{ github.run_id }}-${{ github.run_attempt }}',
    );
    for (const suffix of [
      'e2e-run.json',
      'workloads-to-clean',
      'cleanup-observations.json',
      'vm-*-native-identities.json',
      'vm-*-native-cleanup.json',
      'dedicated-job-result.json',
    ])
      expect(retained.with.path).toContain(suffix);
  });

  it('has no Bash Job leg', () => {
    expect(workflow.jobs).not.toHaveProperty('e2e-tests');
  });

  it('runs every cloud candidate as a required cell', () => {
    for (const test of JOB_ORDER) expect(retired(test), test).toBe(true);
    expect(candidate.strategy.matrix).toEqual({
      test: [...JOB_ORDER, ...VITEST_ONLY],
    });
    expect(candidate['continue-on-error']).toBeUndefined();
    expect(candidate.strategy['fail-fast']).toBe(false);
    expect(candidate.env).not.toHaveProperty('E2E_JOB_FORCE_CLEANUP');
    expect(workflow.on.workflow_dispatch.inputs).not.toHaveProperty(
      'force_job_cleanup',
    );
    expect(candidate['timeout-minutes']).toBe(180);
    expect(candidate.env.E2E_TEST_TIMEOUT_SECONDS).toBe('6600');
    expect(candidate.env).not.toHaveProperty('AWS_SESSION_TOKEN');
    const execution = candidate.steps.find((step) => step.id === 'tests');
    expect(execution.run).toBe(
      'git rev-parse HEAD > /tmp/job-comparison-source-sha.txt\n' +
        './test/integration/e2e.sh ${{ matrix.test }} --vitest\n',
    );
    expect(execution.if).toBe("steps.select.outputs.selected == 'true'");
    expect(execution['continue-on-error']).toBeUndefined();
    const mask = candidate.steps.findIndex(
      (step) => step.name === 'Mask the AWS account ID',
    );
    expect(candidate.steps[mask].run).toBe(
      'bash ci/aws-account-redaction.sh mask',
    );
    expect(mask).toBeLessThan(candidate.steps.indexOf(execution));
    // Raw vitest output and the API log reach artifacts only after a scrub.
    const scrub = candidate.steps.find((step) => step.id === 'scrub');
    expect(scrub.if).toBe(
      "always() && steps.select.outputs.selected == 'true'",
    );
    expect(scrub.run).toContain(
      'bash ci/aws-account-redaction.sh scrub /tmp/e2e-results-*/**/* /tmp/api-e2e.log',
    );
    for (const name of ['Retain Job comparison evidence', 'Upload Job logs']) {
      const upload = candidate.steps.find((step) => step.name === name);
      expect(candidate.steps.indexOf(upload)).toBeGreaterThan(
        candidate.steps.indexOf(scrub),
      );
      expect(upload.if).toContain("steps.scrub.outcome == 'success'");
    }
    const cleanup = workflow.jobs['post-cleanup-aws'].steps;
    expect(
      cleanup.findIndex(
        (step) => step.run === 'bash ci/aws-account-redaction.sh mask',
      ),
    ).toBeLessThan(
      cleanup.findIndex((step) => step.run?.includes('ci/cleanup/aws.ts')),
    );
    expect(workflow.concurrency).toEqual({
      group: 'e2e-job-real-cloud',
      queue: 'max',
      'cancel-in-progress': false,
    });
  });

  it('runs only the requested members and rejects unknown names', () => {
    expect(workflow.on.workflow_dispatch.inputs.tests).toMatchObject({
      type: 'string',
      default: '',
    });
    const select = candidate.steps.find((step) => step.id === 'select');
    const selectIndex = candidate.steps.indexOf(select);
    expect(selectIndex).toBe(1);
    // Every step after the gate either is selected-only or uploads only after
    // a scrub that is itself selected-only.
    for (const step of candidate.steps.slice(selectIndex + 1))
      expect(step.if).toMatch(
        /steps\.select\.outputs\.selected == 'true'|steps\.scrub\.outcome == 'success'/,
      );
    const run = (tests, member) => {
      const dir = mkdtempSync(join(tmpdir(), 'e2e-job-select-'));
      try {
        const output = join(dir, 'output');
        const result = spawnSync('bash', ['-e', '-c', select.run], {
          env: {
            ...process.env,
            TESTS: tests,
            MEMBER: member,
            GITHUB_OUTPUT: output,
          },
          encoding: 'utf8',
        });
        if (result.status !== 0) return result.stderr.trim();
        return readFileSync(output, 'utf8');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    const requested =
      'aws-restricted-credential, aws-spot-eviction azure-spot-eviction,gcp-spot-eviction';
    for (const member of [...JOB_ORDER, ...VITEST_ONLY]) {
      expect(run('', member), member).toBe('selected=true\n');
      expect(run(requested, member), member).toBe(
        `selected=${requested.includes(member)}\n`,
      );
    }
    expect(run('aws-spot-eviction,aws-spot-evicton', 'aws-spot-eviction')).toBe(
      'Unknown e2e-job member: aws-spot-evicton',
    );
  });

  it('retains compact successful and failed observations with exact run and source bindings', () => {
    const upload = candidate.steps.find(
      (step) => step.name === 'Retain Job comparison evidence',
    );
    expect(upload.if).toBe("always() && steps.scrub.outcome == 'success'");
    expect(upload['continue-on-error']).toBeUndefined();
    expect(upload.with['retention-days']).toBe(30);
    expect(upload.with['if-no-files-found']).toBe('error');
    for (const binding of [
      'job-comparison-evidence-cloud-',
      '${{ matrix.test }}',
      '${{ github.run_id }}',
      '${{ github.run_attempt }}',
    ])
      expect(upload.with.name).toContain(binding);
    for (const path of [
      '/tmp/job-comparison-source-sha.txt',
      '/tmp/e2e-results-*/e2e-run.json',
      '/tmp/e2e-results-*/workloads-to-clean',
    ])
      expect(upload.with.path.split('\n')).toContain(path);
    const paths = upload.with.path;
    expect(paths).toContain('/vitest-fixture/*/fixture-record.json');
    expect(paths).toContain('/vitest-fixture/*/cleanup-observations.json');
  });

  it('waits for the candidates before all four provider backstops and credential sweeps', () => {
    for (const provider of ['aws', 'azure', 'gcp', 'lambda']) {
      const cleanup = workflow.jobs['post-cleanup-' + provider];
      expect(cleanup.needs).toBe('e2e-job-vitest');
      expect(cleanup.if).toBe('always() && !cancelled()');
      expect(cleanup['continue-on-error']).toBeUndefined();
      const commands = cleanup.steps.map((step) => step.run ?? '').join('\n');
      expect(commands).toContain(`npx tsx ci/cleanup/${provider}.ts`);
      if (['aws', 'azure', 'gcp'].includes(provider)) {
        const sweep = cleanup.steps.find((step) =>
          step.run?.includes(`cleanup:${provider}-onboarding-e2e`),
        );
        expect(sweep.run).toBe(
          `yarn cleanup:${provider}-onboarding-e2e --suite bucket --sweep`,
        );
        expect(sweep.if).toBe('always()');
        expect(sweep['continue-on-error']).toBeUndefined();
      }
    }
  });

  it('runs a selected exact Azure readback after the existing sweep and retains failed observations', () => {
    expect(
      workflow.on.workflow_dispatch.inputs.azure_identity_readback,
    ).toMatchObject({
      type: 'string',
      default: '',
    });
    const cleanup = workflow.jobs['post-cleanup-azure'];
    const readback = cleanup.steps.find(
      (step) => step.run === 'yarn inspect:azure-job-identity',
    );
    const sweep = cleanup.steps.find((step) =>
      step.run?.startsWith('yarn cleanup:azure-onboarding-e2e'),
    );
    expect(cleanup.steps.indexOf(readback)).toBeGreaterThan(
      cleanup.steps.indexOf(sweep),
    );
    expect(readback.if).toBe(
      "always() && inputs.azure_identity_readback != ''",
    );
    expect(readback['timeout-minutes']).toBe(3);
    expect(readback['continue-on-error']).toBeUndefined();
    expect(readback.env.E2E_AZURE_JOB_IDENTITY_READBACK).toBe(
      '${{ inputs.azure_identity_readback }}',
    );
    const upload = cleanup.steps.find(
      (step) => step.name === 'Retain exact Azure Job identity readback',
    );
    expect(upload.if).toBe(readback.if);
    expect(upload['continue-on-error']).toBeUndefined();
    expect(upload.with).toEqual({
      name: 'job-comparison-evidence-azure-identity-readback-${{ github.run_id }}-${{ github.run_attempt }}',
      path: '/tmp/azure-job-identity-readback/${{ github.run_id }}-${{ github.run_attempt }}/receipt.json',
      'retention-days': 30,
      'if-no-files-found': 'error',
    });
  });

  it('isolates the manual original-identity reader from managed GPU recovery', () => {
    expect(Object.keys(manualRecovery.on)).toEqual(['workflow_dispatch']);
    const inputs = manualRecovery.on.workflow_dispatch.inputs;
    expect(inputs.azure_identity_readback).toMatchObject({
      type: 'string',
      default: '',
    });
    for (const input of ['original_run_id', 'original_run_attempt'])
      expect(inputs[input]).toMatchObject({ type: 'string', required: true });
    expect(Object.keys(manualRecovery.jobs)).toEqual([
      'recover',
      'azure-job-identity-readback',
    ]);
    const recover = manualRecovery.jobs.recover;
    const readback = manualRecovery.jobs['azure-job-identity-readback'];
    expect(recover.if).toBe("inputs.azure_identity_readback == ''");
    expect(readback.if).toBe("inputs.azure_identity_readback != ''");
    expect(recover['timeout-minutes']).toBe(65);
    expect(
      recover.steps.find((step) => step.name?.startsWith('Recover the exact'))
        .run,
    ).toBe(
      'timeout --foreground --kill-after=30s 3600s yarn tsx ci/cleanup/managed-gpu-run.ts \\\n' +
        '  cleanup "$ORIGINAL_RUN_ID" "$ORIGINAL_RUN_ATTEMPT" recovery/managed-gpu-recovery.json\n',
    );
    expect(manualRecovery.concurrency).toEqual({
      group:
        'managed-gpu-recovery-${{ inputs.original_run_id }}-${{ inputs.original_run_attempt }}',
      'cancel-in-progress': false,
    });
    expect(readback.concurrency).toEqual({
      group: 'azure-onboarding-e2e',
      queue: 'max',
      'cancel-in-progress': false,
    });
    expect(readback.permissions).toEqual({ contents: 'read' });
    expect(readback['timeout-minutes']).toBe(10);
    expect(readback).not.toHaveProperty('env');
    expect(readback['continue-on-error']).toBeUndefined();
    const commands = readback.steps.filter((step) => step.run);
    expect(commands.map((step) => step.run)).toEqual([
      'bash scripts/ci-install-dependencies.sh',
      'yarn inspect:azure-job-identity',
    ]);
    expect(commands[0]['timeout-minutes']).toBe(5);
    expect(commands[1]['timeout-minutes']).toBe(3);
    for (const step of commands) {
      expect(step.if).toBeUndefined();
      expect(step['continue-on-error']).toBeUndefined();
    }
    const comparisonReadback = workflow.jobs['post-cleanup-azure'].steps.find(
      (step) => step.run === 'yarn inspect:azure-job-identity',
    );
    expect(commands[1].env).toEqual({
      ...workflow.jobs['post-cleanup-azure'].env,
      ...comparisonReadback.env,
      ORIGINAL_RUN_ID: '${{ inputs.original_run_id }}',
      ORIGINAL_RUN_ATTEMPT: '${{ inputs.original_run_attempt }}',
    });
    expect(readback.steps.filter((step) => step.env)).toEqual([commands[1]]);
    const upload = readback.steps.find((step) =>
      step.uses?.startsWith('actions/upload-artifact@'),
    );
    expect(upload.if).toBe('always()');
    expect(upload['continue-on-error']).toBeUndefined();
    expect(upload.with).toEqual(
      workflow.jobs['post-cleanup-azure'].steps.find((step) =>
        step.name?.startsWith('Retain exact Azure Job identity'),
      ).with,
    );
    expect(readback.steps[0]).toEqual({
      uses: 'actions/checkout@v5',
      with: { 'persist-credentials': false },
    });
  });
});

const gpu = loadYaml(readFileSync('.github/workflows/e2e-gpu.yml', 'utf8'));

describe('provider and image Job wiring', () => {
  it('keeps MACE and all seven disk cases on their original provider locks without altering Service fault inputs', () => {
    const mace = gpu.jobs['e2e-mace-vitest'];
    const disk = gpu.jobs['e2e-disk-tier-vitest'];
    expect(gpu.on.workflow_dispatch.inputs.force_job_cleanup).toMatchObject({
      type: 'boolean',
      default: false,
    });
    expect(mace.strategy.matrix.provider).toBe(
      gpu.jobs['e2e-gpu-serve-vitest'].strategy.matrix.provider,
    );
    expect(mace.concurrency).toEqual(
      gpu.jobs['e2e-gpu-serve-vitest'].concurrency,
    );
    expect(disk.concurrency).toEqual({
      group: 'e2e-gpu-qualification-gcp',
      queue: 'max',
      'cancel-in-progress': false,
    });
    expect(mace.env.MACE_FULL_PULL_IMAGE).toBe(
      'ghcr.io/anycloud-sh/mace@sha256:c60574d120937bd1db9c0c579d427f2b48d307f44c552888952354bf77c2d19d',
    );
    expect(mace.if).toBe(
      '${{ !inputs.azure_ghcr_probe_only && !inputs.service_cleanup_audit }}',
    );
    expect(disk.if).toBe(
      "${{ !inputs.azure_ghcr_probe_only && !inputs.mace_only && !inputs.service_cleanup_audit && (inputs.provider == 'all' || inputs.provider == 'gcp') }}",
    );
    for (const [job, command] of [
      [
        mace,
        './test/integration/e2e.sh ${{ matrix.provider }}-mace-full-pull --vitest',
      ],
      [disk, './test/integration/e2e.sh gcp-disk-tier --vitest'],
    ]) {
      // Both Bash members are retired (RETIREMENT.md): the cells block.
      expect(job['continue-on-error']).toBe(false);
      expect(job['timeout-minutes']).toBe(180);
      expect(job.env.E2E_JOB_FORCE_CLEANUP).toBe(
        "${{ inputs.force_job_cleanup && '1' || '' }}",
      );
      expect(job.env).not.toHaveProperty(
        'E2E_SERVE_FORCE_FAILURE_BEFORE_FINALIZE',
      );
      expect(job.steps.find((step) => step.id === 'tests').run).toBe(
        'git rev-parse HEAD > /tmp/job-comparison-source-sha.txt\n' +
          command +
          '\n',
      );
    }
    expect(gpu.jobs).not.toHaveProperty('qualify');
    expect(gpu.jobs['e2e-gpu-serve-vitest'].env).not.toHaveProperty(
      'E2E_JOB_FORCE_CLEANUP',
    );
    expect(
      gpu.jobs['e2e-gpu-serve-vitest'].env
        .E2E_SERVE_FORCE_FAILURE_BEFORE_FINALIZE,
    ).toBe("${{ inputs.force_service_cleanup && '1' || '' }}");
    for (const target of ['aws', 'azure', 'gcp', 'lambda']) {
      expect(gpu.jobs[`post-cleanup-${target}`].needs).toEqual([
        'e2e-gpu-serve-vitest',
        'e2e-mace-vitest',
        'e2e-disk-tier-vitest',
      ]);
      expect(gpu.jobs[`post-cleanup-${target}`].if).toContain(
        '!inputs.mace_only && !inputs.service_cleanup_audit',
      );
    }
  });

  it('retains candidate MACE and disk-tier cleanup registrations for at least 30 days', () => {
    const candidates = ['e2e-mace-vitest', 'e2e-disk-tier-vitest'].map((name) =>
      gpu.jobs[name].steps.find((step) => step.name?.startsWith('Retain ')),
    );
    for (const upload of candidates) {
      expect(upload.if).toBe('always()');
      expect(upload.with['retention-days']).toBe(30);
      expect(upload.with['if-no-files-found']).toBe('error');
      expect(upload.with.name).toContain(
        '${{ github.run_id }}-${{ github.run_attempt }}',
      );
      expect(upload.with.path).toContain('source-sha.txt');
      expect(upload.with.path).toContain('workloads-to-clean');
      expect(upload.with.path).toContain('e2e-run.json');
    }
    for (const upload of candidates)
      for (const suffix of [
        'fixture-record.json',
        'cleanup-observations',
        'native-',
        'job-*.json',
        'dedicated-job-result.json',
      ])
        expect(upload.with.path).toContain(suffix);
    const tracked = gpu.jobs['e2e-mace-vitest'].steps.find(
      (step) => step.name === 'Require completed MACE Job tracked cleanup',
    );
    expect(tracked.if).toBe('always() && inputs.mace_only');
    expect(tracked.run).toBe(
      'test -f "$RESULTS_DIR/workloads-to-clean"\ntest ! -s "$RESULTS_DIR/workloads-to-clean"\n',
    );
  });

  it('runs the Azure GHCR probe as one required Vitest job with its payload evidence and no account-wide sweep', () => {
    const probe = gpu.jobs['azure-ghcr-probe-vitest'];
    expect(gpu.jobs).not.toHaveProperty('azure-ghcr-probe');
    expect(probe['continue-on-error']).toBe(false);
    expect(probe.env.E2E_JOB_FORCE_CLEANUP).toBe(
      "${{ inputs.force_job_cleanup && '1' || '' }}",
    );
    expect(probe.env.PROBE_MEASURE_BASELINE).toBe(
      "${{ inputs.measure_baseline && '1' || '0' }}",
    );
    expect(probe.env.E2E_TEST_TIMEOUT_SECONDS).toBe(
      "${{ inputs.measure_baseline && '5400' || '3600' }}",
    );
    const job = probe;
    expect(job['timeout-minutes']).toBe(120);
    expect(job.concurrency).toEqual({
      group: 'e2e-gpu-qualification-azure',
      queue: 'max',
      'cancel-in-progress': false,
    });
    expect(job.steps.find((step) => step.id === 'tests').run).toBe(
      'git rev-parse HEAD > /tmp/job-comparison-source-sha.txt\n./test/integration/e2e.sh azure-ghcr-probe --vitest\n',
    );
    expect(
      job.steps.find(
        (step) => step.name === 'Validate runtime capability guard',
      ).run,
    ).toBe('./test/integration/probe-containerd-parallel-pull.sh --self-test');
    const upload = job.steps.find((step) => step.name?.startsWith('Retain '));
    expect(upload.if).toBe('always()');
    expect(upload.with['retention-days']).toBe(30);
    expect(upload.with['if-no-files-found']).toBe('error');
    expect(upload.with.path).toContain('source-sha.txt');
    expect(upload.with.path).toContain('workloads-to-clean');
    expect(upload.with.name).toContain(
      '${{ github.run_id }}-${{ github.run_attempt }}',
    );
    expect(job.steps.map((step) => step.run ?? '').join('\n')).not.toContain(
      'ci/cleanup/azure',
    );
    const retained = probe.steps.find((step) =>
      step.name?.startsWith('Retain '),
    );
    for (const suffix of [
      'cleanup-observations.json',
      'job-*.json',
      'job-*.txt',
      'fixture-record.json',
    ])
      expect(retained.with.path).toContain(suffix);
  });
});
