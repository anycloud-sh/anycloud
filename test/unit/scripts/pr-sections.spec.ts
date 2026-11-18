import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  type FileChange,
  layerOf,
  parseDiff,
  renderE2e,
  renderLayers,
  type Tree,
} from '../../../scripts/pr-sections.js';

const change = (
  path: string,
  status = 'M',
  added = 1,
  deleted = 1,
  from?: string,
): FileChange => ({ status, path, added, deleted, from });
const row = (table: string, layer: string) =>
  table.split('\n').find((line) => line.startsWith(`| ${layer} |`));

describe('pr-sections: runtime layers', () => {
  const table = renderLayers([
    change('src/cli/commands/job.ts', 'M', 3, 1),
    change('migrations/0200_example.sql', 'A', 20, 0),
    change('src/shared/workload.ts', 'M', 5, 0),
    change('src/api/services/kubernetes/pod-termination.ts', 'D', 0, 40),
    change(
      'src/api/services/node-pool-service-admission.ts',
      'R',
      2,
      2,
      'src/api/services/old-admission.ts',
    ),
    change('src/api/services/workload-admission-checks.ts'),
    change('src/api/services/slurm/preflight.ts', 'A', 9, 0),
    change('src/api/services/workload-workflows/targeted-job.ts'),
    change('src/api/composition.ts'),
    change('src/api/brand-new.ts', 'A'),
    change('test/unit/ignored.spec.ts'),
  ]);

  it('marks each file by status, with line counts and a per-cell total', () => {
    expect(row(table, '1 Surface')).toBe(
      '| 1 Surface | 🟡 `cli/commands/job.ts` +3/−1 |  |  |  |',
    );
    expect(row(table, '2 Records')).toBe(
      '| 2 Records | 🟢 🗃️ `0200_example.sql` +20/−0<br>🟡 `shared/workload.ts` +5/−0<br>**+25/−0** |  |  |  |',
    );
    expect(row(table, '4 Contracts')).toBe(
      '| 4 Contracts |  | 🔴 `kubernetes/pod-termination.ts` +0/−40 |  |  |',
    );
    expect(row(table, '5 Admission')).toBe(
      '| 5 Admission |  | 🔵 `node-pool-service-admission.ts` from `old-admission.ts` +2/−2 | 🟡 `workload-admission-checks.ts` +1/−1 | 🟢 `slurm/preflight.ts` +9/−0 |',
    );
    expect(row(table, '6 Loop')).toBe(
      '| 6 Loop |  | 🟡 `workload-workflows/targeted-job.ts` +1/−1 |  |  |',
    );
  });

  it('names untouched layers, files outside the layers, and unmapped files', () => {
    expect(table).toContain(
      'Untouched: 3 Outcome policy, 7 Execution, 8 Capacity.',
    );
    expect(table).toContain(
      'Outside the runtime layers: 🟡 `api/composition.ts` +1/−1.',
    );
    expect(table).toContain(
      'Not in `LAYER_MAP`, so classify them: 🟢 `api/brand-new.ts` +1/−1.',
    );
    expect(table).not.toContain('ignored');
  });

  it('maps every module under src/api/services/', () => {
    const files = execFileSync('git', ['ls-files', 'src/api/services/'])
      .toString()
      .split('\n')
      .filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(100);
    expect(files.filter((f) => !layerOf(f))).toEqual([]);
  });

  it('parses git name-status and numstat output, including renames', () => {
    const nameStatus = [
      'A',
      'a.ts',
      'D',
      'c.ts',
      'R087',
      'old.ts',
      'new.ts',
      '',
    ];
    const numstat = [
      '4\t0\ta.ts',
      '0\t7\tc.ts',
      '3\t1\t',
      'old.ts',
      'new.ts',
      '',
    ];
    expect(parseDiff(nameStatus.join('\0'), numstat.join('\0'))).toEqual([
      { status: 'A', path: 'a.ts', added: 4, deleted: 0 },
      { status: 'D', path: 'c.ts', added: 0, deleted: 7 },
      { status: 'R', path: 'new.ts', from: 'old.ts', added: 3, deleted: 1 },
    ]);
  });
});

const E2E = 'test/integration/e2e/';
const tree = (files: Record<string, string>): Tree => ({
  files: Object.keys(files),
  read: (path) => files[path],
});
const HEAD = {
  [`${E2E}fixture.ts`]: "import './internal/context.js';",
  [`${E2E}internal/context.ts`]: "import './contracts/persistent-vm.js';",
  [`${E2E}internal/wait.ts`]: '',
  [`${E2E}internal/contracts/persistent-vm.ts`]: "import '../wait.js';",
  [`${E2E}specs/cli-exit.spec.ts`]: "import '../internal/wait.js';",
  [`${E2E}specs/contracts/persistent-vm/aws-vm.spec.ts`]: '',
  [`${E2E}specs/contracts/persistent-vm/local-smolvm-vm.spec.ts`]: '',
};
const workflows = {
  'integration.yml':
    'run: ./test/integration/e2e.sh local-smolvm-vm\n- cli-exit\n',
  'e2e-vm.yml': 'run: ./test/integration/e2e.sh ${{ matrix.provider }}-vm\n',
};
const e2e = (changes: FileChange[], head: Record<string, string> = HEAD) =>
  renderE2e({ changes, head: tree(head), base: tree(HEAD), workflows });

describe('pr-sections: e2e', () => {
  it('requires only free members for a shared harness file and lists paid ones as optional', () => {
    const output = e2e([change(`${E2E}internal/wait.ts`)]);
    expect(output).toContain('No end-to-end member changed.');
    expect(output).toContain(
      '- Required, free in `integration.yml`: `cli-exit`, `local-smolvm-vm`.',
    );
    expect(output).toContain(
      '- Required, paid (a linked green dispatch each): none.',
    );
    expect(output).toContain('`persistent-vm` via e2e-vm.yml (1)');
  });

  it('requires paid members through their own spec and through code no free member exercises', () => {
    const {
      [`${E2E}specs/contracts/persistent-vm/aws-vm.spec.ts`]: _,
      ...head
    } = HEAD;
    const deleted = e2e(
      [change(`${E2E}specs/contracts/persistent-vm/aws-vm.spec.ts`, 'D')],
      head,
    );
    expect(deleted).toContain(
      '| `aws-vm` | 🔴 `persistent-vm/aws-vm.spec.ts` +1/−1 | e2e-vm.yml |',
    );
    const gateway = e2e([change('src/api/services/gateways/aws.ts')]);
    expect(gateway).toContain('  - `persistent-vm` via e2e-vm.yml: `aws-vm`');
    expect(gateway).toContain('`local-smolvm-vm`');
    const secrets = {
      ...HEAD,
      [`${E2E}specs/contracts/dedicated-job/aws-runtime-secrets.spec.ts`]: '',
    };
    const flows = { ...workflows, 'e2e-job.yml': '- aws-runtime-secrets\n' };
    for (const path of [
      'src/api/services/docker.ts',
      'src/api/services/runtime-secrets.ts',
      'src/api/rpc/secrets.ts',
    ])
      expect(
        renderE2e({
          changes: [change(path)],
          head: tree(secrets),
          base: tree(secrets),
          workflows: flows,
        }),
      ).toContain('  - `dedicated-job` via e2e-job.yml: `aws-runtime-secrets`');
  });

  it('lists e2e files no member reaches', () => {
    expect(e2e([change(`${E2E}internal/orphan.ts`, 'A')])).toContain(
      'Unmapped, so classify them: 🟢 `internal/orphan.ts` +1/−1.',
    );
  });

  it('requires paid members for cloud-only harness files that free members only appear to reach', () => {
    const imports = (...paths: string[]) =>
      paths.map((p) => `import '../../../internal/${p}.js';`).join('\n');
    const job = `${E2E}specs/contracts/dedicated-job/`;
    const presence = "import '../transports/public-cloud-vm-host-presence.js';";
    const head = {
      [`${job}aws-invalid.spec.ts`]: imports(
        'transports/public-cloud-job',
        'transports/job-spot',
        'transports/job-aws-credential',
      ),
      [`${job}aws-spot-request-cleanup.spec.ts`]: imports(
        'transports/public-cloud-job',
        'transports/job-spot',
        'transports/job-aws-credential',
      ),
      [`${job}aws-bucket-sync.spec.ts`]: imports(
        'transports/public-cloud-job',
        'transports/job-aws-credential',
      ),
      [`${job}gcp-bucket-sync.spec.ts`]: imports('transports/public-cloud-job'),
      [`${E2E}specs/contracts/persistent-vm/aws-vm.spec.ts`]: imports(
        'targets/public-cloud-vm',
      ),
      [`${E2E}specs/contracts/persistent-vm/local-smolvm-vm.spec.ts`]: imports(
        'transports/local-smolvm',
      ),
      [`${E2E}internal/transports/local-smolvm.ts`]:
        "import '../targets/public-cloud-vm.js';",
      [`${E2E}specs/contracts/serve/aws-serve.spec.ts`]: imports(
        'transports/public-cloud-serve',
      ),
      [`${E2E}specs/contracts/serve-local-recovery/local-smolvm-serve.spec.ts`]:
        imports('transports/service-dns'),
      [`${E2E}internal/transports/public-cloud-serve.ts`]:
        "import './service-dns.js';\nimport './public-cloud-vm-host-presence.js';",
      [`${E2E}internal/transports/service-dns.ts`]: '',
      [`${E2E}internal/transports/public-cloud-job.ts`]:
        "import './job-hydration.js';",
      [`${E2E}internal/transports/job-hydration.ts`]: '',
      [`${E2E}internal/transports/job-spot.ts`]: presence,
      [`${E2E}internal/targets/public-cloud-vm.ts`]: presence,
      [`${E2E}internal/transports/public-cloud-vm-host-presence.ts`]: '',
    };
    const flows = {
      'integration.yml':
        '- aws-invalid\n- local-smolvm-vm\n- local-smolvm-serve\n',
      'e2e-job.yml':
        '- aws-spot-request-cleanup\n- ${{ matrix.provider }}-bucket-sync\n',
      'e2e-vm.yml': '- ${{ matrix.provider }}-vm\n',
      'e2e-serve.yml': '- ${{ matrix.provider }}-serve\n',
    };
    const required = (file: string) =>
      /- Required, paid[^\n]*\n((?: {2}- [^\n]*\n?)*)/
        .exec(
          renderE2e({
            changes: [change(`${E2E}internal/${file}`)],
            head: tree(head),
            base: tree(head),
            workflows: flows,
          }),
        )![1]
        .trim();
    expect(required('transports/job-spot.ts')).toBe(
      '- `dedicated-job` via e2e-job.yml: `aws-spot-request-cleanup`',
    );
    expect(required('transports/job-aws-credential.ts')).toBe(
      '- `dedicated-job` via e2e-job.yml: `aws-bucket-sync`, `aws-spot-request-cleanup`',
    );
    expect(required('transports/public-cloud-job.ts')).toBe(
      '- `dedicated-job` via e2e-job.yml: `aws-bucket-sync`, `aws-spot-request-cleanup`, `gcp-bucket-sync`',
    );
    expect(required('targets/public-cloud-vm.ts')).toBe(
      '- `persistent-vm` via e2e-vm.yml: `aws-vm`',
    );
    // A smolvm serve member imports service-dns, but only public-cloud targets run it.
    expect(required('transports/service-dns.ts')).toBe(
      '- `serve` via e2e-serve.yml: `aws-serve`',
    );
    // Host presence serves cloud Job, serve and VM members alike.
    expect(required('transports/public-cloud-vm-host-presence.ts')).toBe(
      [
        '- `serve` via e2e-serve.yml: `aws-serve`',
        '  - `dedicated-job` via e2e-job.yml: `aws-spot-request-cleanup`',
        '  - `persistent-vm` via e2e-vm.yml: `aws-vm`',
      ].join('\n'),
    );
    // A helper of the public-cloud Job transport reaches only dedicated-job members.
    expect(required('transports/job-hydration.ts')).toBe(
      '- `dedicated-job` via e2e-job.yml: `aws-bucket-sync`, `aws-spot-request-cleanup`, `gcp-bucket-sync`',
    );
  });
});
