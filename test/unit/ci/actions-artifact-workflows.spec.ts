import { readFileSync, readdirSync } from 'node:fs';
import { loadYaml } from '@kubernetes/client-node';
import { describe, expect, it } from 'vitest';
import { artifactKind } from '../../../ci/cleanup/actions-artifact-policy.mjs';

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  if?: string;
  run?: string;
  'continue-on-error'?: boolean;
  with?: Record<string, string | number | boolean>;
}
interface Workflow {
  name: string;
  on?: {
    workflow_run?: { workflows: string[] };
    workflow_call?: unknown;
    schedule?: unknown;
  };
  env?: Record<string, string>;
  jobs: Record<
    string,
    {
      uses?: string;
      if?: string;
      needs?: string;
      steps?: Step[];
      'continue-on-error'?: boolean;
    }
  >;
}
const workflow = (name: string) =>
  loadYaml<Workflow>(readFileSync('.github/workflows/' + name, 'utf8'));
const sampleName = (name: string) =>
  name.replace(/\$\{\{(.*?)\}\}/g, (_, expression: string) =>
    expression.includes("'amd64'") ? 'amd64' : '123',
  );

describe('Actions artifact workflow policy', () => {
  it('VM comparison uploads use retained fixture records rather than raw Local inventory files', () => {
    const uploads = ['e2e-vm.yml', 'integration.yml'].flatMap((file) =>
      Object.values(workflow(file).jobs)
        .flatMap((job) => job.steps ?? [])
        .filter((step) =>
          String(step.with?.name).startsWith('vm-comparison-evidence-'),
        ),
    );
    expect(uploads).toHaveLength(2);
    for (const upload of uploads) {
      const paths = String(upload.with?.path).trim().split('\n');
      expect(paths).toContain('/tmp/e2e-results-*/');
      for (const path of paths)
        expect(
          path === '/tmp/vm-comparison-source-sha.txt' ||
            path === '/tmp/e2e-results-*/',
          `unvalidated comparison upload path: ${path}`,
        ).toBe(true);
    }
  });

  it('classifies every upload, bounds retention, and schedules cleanup for its producer', () => {
    const cleanup = workflow('actions-storage.yml');
    const lifetimes: Record<string, number> = {
      recovery: 30,
      mutation: 7,
      performance: 7,
      candidate: 7,
      release: 7,
      transfer: 1,
      diagnostic: 3,
    };
    for (const file of readdirSync('.github/workflows').filter((entry) =>
      entry.endsWith('.yml'),
    )) {
      const producer = workflow(file);
      for (const job of Object.values(producer.jobs)) {
        const steps = job.steps ?? [];
        for (const [index, step] of steps.entries()) {
          if (step.uses?.startsWith('docker/build-push-action@')) {
            expect(String(producer.env?.DOCKER_BUILD_RECORD_UPLOAD), file).toBe(
              'false',
            );
          }
          if (!step.uses?.startsWith('actions/upload-artifact@')) continue;
          const name = String(step.with?.name);
          const kind = artifactKind(sampleName(name));
          const label = `${file}: ${name}`;
          expect(lifetimes, label).toHaveProperty(kind);
          expect(step.with?.['retention-days'], label).toBe(lifetimes[kind]);
          expect(cleanup.on?.workflow_run?.workflows, file).toContain(
            producer.name,
          );
          if (kind === 'diagnostic') {
            expect(step.if, file).toContain('failure()');
            expect(step.if, file).toContain('cancelled()');
            expect(step.if, file).toContain(
              "contains(steps.*.outcome, 'failure')",
            );
            expect(step['continue-on-error'], file).toBe(true);
            for (const prior of steps.slice(0, index)) {
              if (
                prior['continue-on-error'] &&
                !prior.uses?.startsWith('actions/upload-artifact@')
              )
                expect(
                  prior.id,
                  file + ': allowed failures need an ID for steps.*.outcome',
                ).toBeTruthy();
            }
          } else {
            expect(step['continue-on-error'], file).not.toBe(true);
            expect(step.with?.['if-no-files-found'], file).toBe('error');
          }
        }
      }
    }
  });

  it('uses default-branch cleanup code for completion events and preflight calls', () => {
    const cleanup = workflow('actions-storage.yml');
    expect(cleanup.on?.schedule).toBeDefined();
    expect(cleanup.on?.workflow_call).toBeDefined();
    expect(cleanup.jobs.cleanup.steps?.[0].with).toMatchObject({
      ref: '${{ github.event.repository.default_branch }}',
      'persist-credentials': false,
    });
    const jobs = workflow('release.yml').jobs;
    expect(jobs['artifact-cleanup'].uses).toBe(
      'anycloud-sh/anycloud/.github/workflows/actions-storage.yml@main',
    );
    const producer = jobs.prepare;
    expect(producer.needs).toBe('artifact-cleanup');
    expect(producer.if).toContain("needs.artifact-cleanup.result == 'success'");
  });

  it('keeps cleanup records separate from optional logs', () => {
    const lambda = workflow('lambda-boot-failover.yml').jobs['forced-timeout']
      .steps!;
    const ledger = lambda.find(
      (step) => step.name === 'Upload cleanup ledger',
    )!;
    expect(ledger).toMatchObject({
      if: 'always()',
      with: {
        path: '/tmp/lambda-boot-failover-ledger-${{ matrix.trial }}.json',
      },
    });
  });

  it('keeps missing required downloads fatal and explains a fresh dispatch', () => {
    const action = loadYaml<{ runs: { steps: Step[] } }>(
      readFileSync(
        '.github/actions/download-retained-artifact/action.yml',
        'utf8',
      ),
    );
    const failure = action.runs.steps[1];
    expect(failure.if).toContain("steps.download.outcome == 'failure'");
    expect(failure.run).toContain('fresh workflow dispatch');
    expect(failure.run).toContain('exit 1');
    const source = readFileSync('.github/workflows/release.yml', 'utf8');
    expect(source).not.toContain('uses: actions/download-artifact@');
    expect(source).toContain(
      'uses: anycloud-sh/anycloud/.github/actions/download-retained-artifact@main',
    );
  });
});
