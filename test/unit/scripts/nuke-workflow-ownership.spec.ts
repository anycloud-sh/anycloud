import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function workflowSource(name: string): string {
  return readFileSync(`.github/workflows/${name}`, 'utf8');
}

function jobBlock(source: string, name: string): string {
  const jobs = source.slice(source.indexOf('\njobs:\n') + 1);
  const headings = [...jobs.matchAll(/^ {2}([a-zA-Z0-9_-]+):\n/gm)];
  const index = headings.findIndex((heading) => heading[1] === name);
  expect(index, `missing workflow job ${name}`).toBeGreaterThanOrEqual(0);
  const start = headings[index].index;
  const end = headings[index + 1]?.index ?? jobs.length;
  return jobs.slice(start, end);
}

describe('nuke workflow ownership', () => {
  it('keeps one reusable nuke implementation', () => {
    const canonical = workflowSource('nuke.yml');
    const integration = workflowSource('integration.yml');
    const integrationNuke = jobBlock(integration, 'local-smolvm-nuke');

    expect(canonical).toMatch(/^ {2}workflow_call:\n/m);
    expect(integrationNuke).toContain('uses: ./.github/workflows/nuke.yml');
    expect(integrationNuke).not.toContain('runs-on:');
    expect(integrationNuke).not.toContain('steps:');
    for (const provider of ['local', 'aws', 'azure', 'gcp', 'lambda']) {
      expect(canonical).toContain(`          - ${provider}`);
    }
    expect(canonical).toContain('Post-test cloud cleanup');

    const inlineInvocations = [canonical, integration].flatMap(
      (source) => source.match(/\.\/test\/integration\/e2e\.sh nuke/g) ?? [],
    );
    expect(inlineInvocations).toHaveLength(1);
  });

  it('selects Local or cloud runtime defaults without dispatch-only arguments', () => {
    const canonical = workflowSource('nuke.yml');

    expect(canonical).toContain(
      "NUKE_DEADLINE_SEC: ${{ inputs.deadline_sec || ((inputs.provider || 'azure') == 'local' && '900' || '9000') }}",
    );
    expect(canonical).toContain(
      "NUKE_RUNTIME_SEC: ${{ inputs.runtime_sec || ((inputs.provider || 'azure') == 'local' && '10' || '30') }}",
    );
    expect(canonical).toContain(
      "E2E_TEST_TIMEOUT_SECONDS: ${{ inputs.e2e_timeout_seconds || ((inputs.provider || 'azure') == 'local' && '1800' || '10800') }}",
    );
  });

  it.each([
    [
      'local',
      '',
      'mirror.gcr.io/library/busybox:1.36@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662',
    ],
    ['local', 'busybox:1.36', 'busybox:1.36'],
    [
      'local',
      'registry.example.test/custom:fixture',
      'registry.example.test/custom:fixture',
    ],
    ['aws', '', 'alpine'],
    [
      'aws',
      'registry.example.test/custom:fixture',
      'registry.example.test/custom:fixture',
    ],
  ])(
    'selects the %s image fixture or override %s before API setup',
    (provider, override, expected) => {
      const result = spawnSync('bash', ['test/integration/nuke.test.sh'], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          API_URL: '',
          NUKE_PROVIDER: provider,
          NUKE_IMAGE: override,
          AWS_ACCESS_KEY_ID: 'offline-fixture',
          AWS_SECRET_ACCESS_KEY: 'offline-fixture',
        },
      });
      const output = result.stdout + result.stderr;
      expect(result.status).toBe(1);
      expect(output).toContain(`image=${expected} `);
      expect(output).toContain('API_URL must be set');
      expect(output).not.toContain('offline-fixture');
    },
  );

  it('keeps the interruption control opt-in and validates its exact failure after every backstop', () => {
    const canonical = workflowSource('nuke.yml');
    expect(
      canonical.match(
        /interrupt_after_witness:\n\s+description:.*\n\s+type: boolean\n\s+default: false/g,
      ),
    ).toHaveLength(2);
    expect(canonical).toContain(
      'continue-on-error: ${{ inputs.interrupt_after_witness || false }}',
    );
    expect(canonical).toContain(
      'NUKE_TESTS_OUTCOME: ${{ steps.tests.outcome }}',
    );
    expect(canonical).toContain(
      'NUKE_LOCAL_CLEANUP_OUTCOME: ${{ steps.local_cleanup.outcome }}',
    );
    expect(canonical).toContain(
      'NUKE_CLOUD_CLEANUP_OUTCOME: ${{ steps.cloud_cleanup.outcome }}',
    );
    const cleanup = canonical.indexOf('- name: Post-test cloud cleanup');
    const capture = canonical.indexOf(
      '- name: Capture nuke implementation evidence',
    );
    const upload = canonical.indexOf(
      '- name: Upload nuke implementation evidence',
    );
    const validate = canonical.indexOf(
      '- name: Validate nuke outcome and cleanup',
    );
    expect(cleanup).toBeLessThan(capture);
    expect(capture).toBeLessThan(upload);
    expect(upload).toBeLessThan(validate);
    expect(canonical.slice(capture, upload)).toContain('if: always()');
    expect(canonical.slice(upload, validate)).toContain('if: always()');
    expect(canonical.slice(upload, validate)).toContain('retention-days: 30');
    expect(canonical.slice(upload, validate)).toContain(
      'if-no-files-found: error',
    );
    expect(canonical.slice(upload, validate)).toContain(
      'name: implementation-evidence-nuke-${{ env.PROVIDER }}-${{ github.run_id }}-${{ github.run_attempt }}',
    );
    const validation = canonical.slice(
      validate,
      canonical.indexOf('- name: Upload API logs'),
    );
    expect(validation).toContain('if: always()');
    expect(validation).not.toContain('continue-on-error:');
    expect(canonical).toContain('retention-days: 3');
  });

  it('owns count-independent provider-aware host sampling in the shared harness', () => {
    const integration = workflowSource('integration.yml');
    const harness = readFileSync('test/integration/nuke.test.sh', 'utf8');

    expect(integration).not.toContain('sample_host()');
    expect(harness).toContain('start_host_sampler');
    expect(harness).toContain('evaluate_host_metrics');
    expect(harness).toContain('NUKE_PROVIDER="$NUKE_PROVIDER"');
    expect(harness).not.toMatch(
      /start_host_sampler\(\)[\s\S]{0,150}NUKE_IS_LOCAL/,
    );
    expect(harness).not.toMatch(/NUKE_COUNT[^\n]*(?:!=|==)[^\n]*50/);
  });

  it.each(['abc', '0', '-1', '101'])(
    'rejects invalid completion gate percentage %s before setup',
    (passPct) => {
      const result = spawnSync('bash', ['test/integration/nuke.test.sh'], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          API_URL: '',
          NUKE_PASS_PCT: passPct,
          NUKE_PROVIDER: 'local',
        },
      });

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain(
        `NUKE_PASS_PCT must be an integer from 1 to 100 (got '${passPct}')`,
      );
    },
  );

  it.each(['20', '50', '299'])(
    'rejects an undersized %s-job fairness fixture before setup',
    (count) => {
      const result = spawnSync('bash', ['test/integration/nuke.test.sh'], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          API_URL: '',
          NUKE_PROVIDER: 'local',
          NUKE_COUNT: count,
        },
      });
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain(
        'NUKE_COUNT must be at least 300 to exercise queue fairness',
      );
    },
  );

  it('requires at least one fairness witness', () => {
    const result = spawnSync('bash', ['test/integration/nuke.test.sh'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        API_URL: '',
        NUKE_PROVIDER: 'local',
        NUKE_COUNT: '300',
        NUKE_FAIRNESS_WITNESS_COUNT: '0',
      },
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      'NUKE_FAIRNESS_WITNESS_COUNT must be a positive integer',
    );
  });

  it('rejects an ambiguous interruption input before setup', () => {
    const result = spawnSync('bash', ['test/integration/nuke.test.sh'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        API_URL: '',
        NUKE_PROVIDER: 'local',
        NUKE_INTERRUPT_AFTER_WITNESS: 'maybe',
      },
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      'NUKE_INTERRUPT_AFTER_WITNESS must be true or false',
    );
  });
});
