import { spawnSync } from 'child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const projectRoot = join(__dirname, '../../..');
const helperPath = join(
  projectRoot,
  'test/integration/helpers/nuke-cleanup.sh',
);
const harness = readFileSync(
  join(projectRoot, 'test/integration/nuke.test.sh'),
  'utf8',
);
const cleanupDefinition = harness.slice(
  harness.indexOf('\ncleanup() {'),
  harness.indexOf('\nnuke_install_cleanup_traps'),
);
const submissionDefinitions = harness.slice(
  harness.indexOf('\nsubmit_log_path() {'),
  harness.indexOf('\nrecord_witness_sample() {'),
);
let fixtureDir: string;

beforeEach(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'nuke-cleanup-'));
});

afterEach(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

const callHelper = (body: string) =>
  spawnSync(
    'bash',
    [
      '-c',
      `
        print_error() { printf '%s\\n' "$*" >&2; }
        print_warning() { printf '%s\\n' "$*" >&2; }
        print_info() { :; }
        print_section() { :; }
        trace="$3/trace"
        declare -a SUBMIT_PIDS
        source "$1"
        eval "$4"
        eval "$5"
        eval "$2"
      `,
      'bash',
      helperPath,
      body,
      fixtureDir,
      cleanupDefinition,
      submissionDefinitions,
    ],
    { encoding: 'utf-8', timeout: 10_000, killSignal: 'SIGKILL' },
  );

/**
 * The fake API's trace. One cohort's terminations run in parallel, so they are
 * sorted within each run of the same cohort; cohorts and drains keep order.
 */
function cleanupTrace(): string[] {
  const lines = readFileSync(join(fixtureDir, 'trace'), 'utf8')
    .trim()
    .split('\n');
  const step = (line: string) =>
    line.startsWith('terminate:')
      ? line.split(':').slice(0, 2).join(':')
      : line;
  const ordered: string[] = [];
  let run: string[] = [];
  for (const line of lines) {
    if (run.length > 0 && step(run[0]) !== step(line)) {
      ordered.push(...run.sort());
      run = [];
    }
    run.push(line);
  }
  return [...ordered, ...run.sort()];
}

describe('nuke cleanup policy', () => {
  it('attempts every termination before starting one drain deadline', () => {
    const result = callHelper(`
      trace=$(mktemp)
      api_terminate() {
        printf 'terminate:%s\\n' "$1" >> "$trace"
        [ "$1" != dep-a ]
      }
      date() {
        printf 'deadline\\n' >> "$trace"
        echo 100
      }
      nuke_assert_workloads_vms_ended() {
        label=$1
        deadline=$2
        shift 2
        printf 'assert:%s:%s:%s\\n' "$label" "$deadline" "$*" >> "$trace"
      }

      set +e
      nuke_terminate_and_drain "test cleanup" 20 dep-a dep-b
      schedule_rc=$?
      set -e

      cat "$trace"
      printf 'rc:%s\\n' "$schedule_rc"
      rm -f "$trace"
    `);

    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual([
      'terminate:dep-a',
      'terminate:dep-b',
      'deadline',
      'assert:test cleanup:120:dep-a dep-b',
      'rc:1',
    ]);
  });

  it('bounds local termination concurrency and retains individual failures', () => {
    const ids = Array.from({ length: 17 }, (_, index) => `dep-${index}`);
    const result = callHelper(`
      NUKE_IS_LOCAL=true
      NUKE_CLEANUP_RECORD_DIR="$3/records"
      api_terminate() {
        printf 'start:%s\\n' "$1" >> "$trace"
        sleep 0.08
        printf 'end:%s\\n' "$1" >> "$trace"
        [ "$1" != dep-9 ]
      }
      nuke_assert_workloads_vms_ended() {
        printf 'drain\\n' >> "$trace"
      }
      nuke_terminate_and_drain "local cleanup" 20 ${ids.join(' ')}
      printf 'rc:%s\\n' "$?"
    `);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('rc:1');
    const events = readFileSync(join(fixtureDir, 'trace'), 'utf8')
      .trim()
      .split('\n');
    let active = 0;
    let peak = 0;
    for (const event of events) {
      if (event.startsWith('start:')) peak = Math.max(peak, ++active);
      if (event.startsWith('end:')) active--;
    }
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
    expect(active).toBe(0);
    expect(events.at(-1)).toBe('drain');
    expect(events.filter((event) => event.startsWith('start:')).sort()).toEqual(
      ids.map((id) => `start:${id}`).sort(),
    );
    expect(
      JSON.parse(readFileSync(join(fixtureDir, 'records/normal.json'), 'utf8')),
    ).toMatchObject({
      ids,
      terminationFailedIds: ['dep-9'],
      vmsEnded: true,
    });
  });

  it('preserves a clean exit when cleanup succeeds', () => {
    const result = callHelper(`
      cleanup() { printf 'cleanup\\n'; return 0; }
      nuke_install_cleanup_traps
      exit 0
    `);

    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual(['cleanup']);
  });

  it('turns a clean exit into a failure when cleanup fails', () => {
    const result = callHelper(`
      cleanup() { printf 'cleanup\\n'; return 1; }
      nuke_install_cleanup_traps
      exit 0
    `);

    expect(result.status).toBe(1);
    expect(result.stdout.trim().split('\n')).toEqual(['cleanup']);
  });

  it('preserves an existing failure when cleanup also fails', () => {
    const result = callHelper(`
      cleanup() { printf 'cleanup\\n'; return 1; }
      nuke_install_cleanup_traps
      exit 7
    `);

    expect(result.status).toBe(7);
    expect(result.stdout.trim().split('\n')).toEqual(['cleanup']);
    expect(result.stderr).toContain(
      'Nuke cleanup failed (exit 1); original exit was 7',
    );
  });

  it('converts SIGINT to exit 130 and runs cleanup once', () => {
    const result = callHelper(`
      cleanup() { printf 'cleanup\\n'; }
      nuke_install_cleanup_traps
      kill -INT $$
    `);

    expect(result.status).toBe(130);
    expect(result.stdout.trim().split('\n')).toEqual(['cleanup']);
  });

  it('converts SIGTERM to exit 143 and runs cleanup once', () => {
    const result = callHelper(`
      cleanup() { printf 'cleanup\\n'; }
      nuke_install_cleanup_traps
      kill -TERM $$
    `);

    expect(result.status).toBe(143);
    expect(result.stdout.trim().split('\n')).toEqual(['cleanup']);
  });

  it.each([
    ['exit 0', 1],
    ['exit 7', 7],
    ['kill -INT $$', 130],
    ['kill -TERM $$', 143],
  ])(
    'finishes cleanup once despite repeated signals after %s',
    (trigger, expectedStatus) => {
      const result = callHelper(`
        cleanup() {
          printf 'cleanup:start\\n'
          kill -TERM $$
          kill -INT $$
          bash -c 'kill -TERM "$1"; kill -INT "$1"' bash $$
          printf 'cleanup:end\\n'
          return 1
        }
        nuke_install_cleanup_traps
        ${trigger}
      `);

      expect(result.status).toBe(expectedStatus);
      expect(result.stdout.trim().split('\n')).toEqual([
        'cleanup:start',
        'cleanup:end',
      ]);
      expect(result.stderr).toContain('Nuke cleanup failed (exit 1)');
    },
  );

  it.each([false, true])(
    'stops the complete submission group (stopped: %s) and preserves unrelated jobs',
    (stopped) => {
      const result = callHelper(`
      sleep 3 &
      unrelated_pid=$!
      nuke_launch_submission bash -c '
        trap "" TERM
        printf "ready\\n" > "$1"
        sleep 2
        printf "late admission\\n" >> "$1"
      ' bash "$trace"
      submit_pid=$NUKE_SUBMIT_PID
      while [ ! -f "$trace" ]; do sleep 0.01; done
      ${stopped ? 'kill -STOP -- "-$submit_pid"' : ''}
      nuke_stop_submissions 0
      stop_rc=$?
      if kill -0 -- "-$submit_pid" 2>/dev/null; then
        printf 'submit group still live\\n'
      fi
      kill -0 "$unrelated_pid" && printf 'unrelated still live\\n'
      kill "$unrelated_pid"
      wait "$unrelated_pid" 2>/dev/null || true
      cat "$trace"
      printf 'stop:%s:tracked:%s\\n' "$stop_rc" "\${#SUBMIT_PIDS[@]}"
    `);

      expect(result.status).toBe(0);
      expect(result.stdout.trim().split('\n')).toEqual([
        'unrelated still live',
        'ready',
        'stop:0:tracked:0',
      ]);
    },
  );

  it('defers the first signal until a just-started submit has been registered', () => {
    const result = callHelper(`
      cleanup() {
        printf 'registered:%s\\n' "\${#SUBMIT_PIDS[@]}"
        nuke_stop_submissions 0
        printf 'reaped\\n'
      }
      nuke_install_cleanup_traps
      set -T
      trap 'if [[ "$BASH_COMMAND" == NUKE_SUBMIT_PID=* ]]; then
        trap - DEBUG
        kill -INT $$
        kill -TERM $$
      fi' DEBUG
      nuke_launch_submission sleep 2
      printf 'should not continue\\n'
    `);

    expect(result.status).toBe(130);
    expect(result.stdout.trim().split('\n')).toEqual([
      'registered:1',
      'reaped',
    ]);
  });

  it.each([
    ['submit_one', true],
    ['submit_witness_one', true],
    ['submit_one', false],
    ['submit_witness_one', false],
  ])(
    'owns the real %s timeout and CLI descendants (local: %s)',
    (submit, local) => {
      const cliDir = join(fixtureDir, 'dist/cli');
      mkdirSync(cliDir, { recursive: true });
      writeFileSync(
        join(cliDir, 'index.js'),
        `
        const { writeFileSync } = require('node:fs');
        const { join } = require('node:path');
        process.on('SIGTERM', () => {});
        writeFileSync(join(__dirname, '../../ready'), String(process.pid));
        setTimeout(() => process.exit(0), 2000);
      `,
      );
      const result = callHelper(`
      PROJECT_ROOT="$3"
      NUKE_SUBMIT_LOG_DIR="$3"
      API_URL=http://unused
      NUKE_IS_LOCAL=${String(local)}
      NUKE_USES_BUCKET_SYNC=false
      NUKE_USES_SPOT=false
      NUKE_CREDENTIAL=unused
      NUKE_VMTYPE=unused
      NUKE_IMAGE=unused
      NUKE_RUNTIME_SEC=1
      NUKE_SUBMIT_TIMEOUT_SEC=5
      SUBMIT_TIMEOUT_CMD=$(command -v timeout || command -v gtimeout)
      nuke_launch_submission ${submit} test-id 1
      for i in $(seq 1 200); do
        [ ! -f "$3/ready" ] || break
        sleep 0.01
      done
      [ -f "$3/ready" ] || exit 1
      cli_pid=$(cat "$3/ready")
      nuke_stop_submissions 0
      stop_rc=$?
      # A killed grandchild may briefly be a zombie until the system reaps it.
      for i in $(seq 1 10); do
        kill -0 "$cli_pid" 2>/dev/null || break
        sleep 0.05
      done
      if kill -0 "$cli_pid" 2>/dev/null; then
        printf 'CLI still alive\\n'
        kill -KILL "$cli_pid"
      fi
      printf 'stop:%s\\n' "$stop_rc"
    `);

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('stop:0');
    },
  );

  it.each([0, 22])(
    'drains pretracked lost-reply and interrupted submissions for both cohorts with termination status %s',
    (terminationStatus) => {
      const result = callHelper(`
        GITHUB_TOKEN=normal-token
        NUKE_FAIRNESS_USER=witness
        NUKE_CLASSIFICATION_EMITTED=true
        NUKE_USES_BUCKET_SYNC=false
        NUKE_IS_LOCAL=false
        NUKE_PROVIDER=aws
        NUKE_CLEANUP_DRAIN_SEC=0
        NUKE_IDS=(normal-lost-reply normal-inflight)
        NUKE_WITNESS_IDS=(witness-lost-reply witness-inflight)
        lost_reply() { printf 'admitted:%s\\n' "$1" >> "$trace"; return 42; }
        nuke_launch_submission lost_reply normal-lost-reply
        wait "$NUKE_SUBMIT_PID" || true
        nuke_launch_submission lost_reply witness-lost-reply
        wait "$NUKE_SUBMIT_PID" || true
        nuke_launch_submission sleep 3
        normal_pid=$NUKE_SUBMIT_PID
        nuke_launch_submission sleep 3
        witness_pid=$NUKE_SUBMIT_PID
        api_terminate() {
          if kill -0 -- "-$normal_pid" 2>/dev/null ||
             kill -0 -- "-$witness_pid" 2>/dev/null; then
            printf 'termination raced a live submit\\n' >> "$trace"
            return 1
          fi
          printf 'terminate:%s:%s\\n' "\${NUKE_CLEANUP_COHORT:-normal}" "$1" >> "$trace"
          if [ "$1" = normal-inflight ]; then return ${terminationStatus}; fi
        }
        nuke_assert_workloads_vms_ended() {
          shift 2
          printf 'drain:%s:%s\\n' "\${NUKE_CLEANUP_COHORT:-normal}" "$*" >> "$trace"
        }
        cleanup
        cleanup_rc=$?
        cat "$trace"
        printf 'rc:%s:cohort:%s\\n' "$cleanup_rc" "\${NUKE_CLEANUP_COHORT:-normal}"
      `);

      expect(result.status).toBe(0);
      expect(result.stdout.trim().split('\n')).toEqual([
        'admitted:normal-lost-reply',
        'admitted:witness-lost-reply',
        'terminate:normal:normal-lost-reply',
        'terminate:normal:normal-inflight',
        'drain:normal:normal-lost-reply normal-inflight',
        'terminate:witness:witness-lost-reply',
        'terminate:witness:witness-inflight',
        'drain:witness:witness-lost-reply witness-inflight',
        `rc:${terminationStatus === 0 ? 0 : 1}:cohort:normal`,
      ]);
    },
  );

  it('reports an unresolved submission shutdown even if Workload cleanup succeeds', () => {
    const result = callHelper(`
      NUKE_CLASSIFICATION_EMITTED=true
      NUKE_USES_BUCKET_SYNC=false
      NUKE_IS_LOCAL=false
      NUKE_PROVIDER=aws
      NUKE_CLEANUP_DRAIN_SEC=0
      NUKE_IDS=(normal)
      NUKE_WITNESS_IDS=()
      nuke_stop_submissions() { return 1; }
      api_terminate() { printf 'terminated:%s\\n' "$1"; }
      nuke_assert_workloads_vms_ended() { printf 'drained\\n'; }
      cleanup
    `);

    expect(result.status).toBe(1);
    expect(result.stdout.trim().split('\n')).toEqual([
      'terminated:normal',
      'drained',
    ]);
  });

  it.each([
    ['drain', 'exit 0', 1],
    ['drain', 'exit 7', 7],
    ['drain', 'kill -TERM $$', 143],
    ['termination', 'exit 0', 1],
    ['termination', 'exit 7', 7],
    ['termination', 'kill -TERM $$', 143],
  ])(
    'contains an exiting %s assertion and finishes both cohorts after %s',
    (failure, trigger, expectedStatus) => {
      const cliDir = join(fixtureDir, 'dist/cli');
      mkdirSync(cliDir, { recursive: true });
      writeFileSync(
        join(cliDir, 'index.js'),
        `
        const prefix = process.argv[process.argv.indexOf('--filter') + 1];
        const ids = ['nuke-1231-1', 'nuke-1231-2', 'nuke-witness-1231-1']
          .filter(id => id.startsWith(prefix));
        process.stdout.write(JSON.stringify(ids.map(id => ({ id, state: 'running' }))));
      `,
      );
      const result = callHelper(`
        source "$(dirname "$1")/nuke-db.sh"
        unset SQLITE_PATH ANYCLOUD_DIR
        PROJECT_ROOT="$3"
        NUKE_CLEANUP_RECORD_DIR="$3/records"
        API_URL=http://unused
        TEST_RUN=1231
        NUKE_COUNT=300
        GITHUB_TOKEN=normal-token
        NUKE_FAIRNESS_USER=witness
        NUKE_CLASSIFICATION_EMITTED=true
        NUKE_USES_BUCKET_SYNC=false
        NUKE_IS_LOCAL=false
        NUKE_PROVIDER=aws
        NUKE_CLEANUP_DRAIN_SEC=0
        NUKE_IDS=(nuke-1231-1 nuke-1231-2)
        NUKE_WITNESS_IDS=(nuke-witness-1231-1)
        # Match common.sh's fail contract. The actual nuke-db assertion calls
        # this on a failed ledger drain, exiting the shell rather than returning.
        fail() { print_error "$*"; exit 1; }
        api_terminate() {
          printf 'terminate:%s:%s\\n' "\${NUKE_CLEANUP_COHORT:-normal}" "$1" >> "$trace"
          ${failure === 'termination' ? '[ "$1" != nuke-1231-1 ] || exit 19' : ':'}
        }
        wait_for_workloads_no_live_vms_until() {
          shift
          printf 'drain:%s:%s\\n' "\${NUKE_CLEANUP_COHORT:-normal}" "$*" >> "$trace"
          ${failure === 'drain' ? '[ "${NUKE_CLEANUP_COHORT:-normal}" != normal ]' : ':'}
        }
        nuke_install_cleanup_traps
        ${trigger}
      `);

      expect(result.status, result.stderr).toBe(expectedStatus);
      expect(cleanupTrace()).toEqual([
        'terminate:normal:nuke-1231-1',
        'terminate:normal:nuke-1231-2',
        'drain:normal:nuke-1231-1 nuke-1231-2',
        'terminate:witness:nuke-witness-1231-1',
        'drain:witness:nuke-witness-1231-1',
      ]);
      const record = (name: string) =>
        JSON.parse(readFileSync(join(fixtureDir, 'records', name), 'utf8'));
      expect(record('normal.json')).toMatchObject({
        cohort: 'normal',
        ids: ['nuke-1231-1', 'nuke-1231-2'],
        terminationFailedIds: failure === 'termination' ? ['nuke-1231-1'] : [],
        vmsEnded: failure !== 'drain',
      });
      expect(record('witness.json')).toMatchObject({
        cohort: 'witness',
        ids: ['nuke-witness-1231-1'],
        terminationFailedIds: [],
        vmsEnded: true,
      });
      const primaryExit = trigger === 'exit 0' ? 0 : expectedStatus;
      expect(record('result.json')).toMatchObject({
        exitCode: primaryExit,
        cleanupExitCode: 1,
      });
      expect(result.stderr).toContain(
        `Nuke cleanup failed (exit 1); original exit was ${primaryExit}`,
      );
    },
  );

  function interruptAdmittedWitness(
    options: {
      terminal?: boolean;
      invalidInventory?: boolean;
      cleanupFailure?: boolean;
      invalidImage?: boolean;
      laterInventoryFailure?: boolean;
      witnessCount?: number;
    } = {},
  ) {
    const witnessIds = Array.from(
      { length: options.witnessCount ?? 1 },
      (_, index) => `nuke-witness-1231-${index + 1}`,
    );
    const cliDir = join(fixtureDir, 'dist/cli');
    mkdirSync(cliDir, { recursive: true });
    writeFileSync(
      join(cliDir, 'index.js'),
      `
      if (process.argv[2] === 'list') {
        const prefix = process.argv[process.argv.indexOf('--filter') + 1];
        const witness = prefix === 'nuke-witness-1231-';
        const ids = [...${JSON.stringify(witnessIds)}, 'nuke-1231-1', 'nuke-1231-2']
          .filter(id => id.startsWith(prefix));
        const limit = Number(process.argv[process.argv.indexOf('-n') + 1]);
        if (witness && ${Boolean(options.laterInventoryFailure)}) {
          const fs = require('node:fs');
          const path = ${JSON.stringify(join(fixtureDir, 'witness-reads'))};
          const count = fs.existsSync(path) ? Number(fs.readFileSync(path, 'utf8')) : 0;
          fs.writeFileSync(path, String(count + 1));
          if (count > 0) { process.stderr.write('private-token-canary'); process.exit(7); }
        }
        const rows = ids.slice(0, limit).map(id => ({ id, state: ${JSON.stringify(options.terminal ? 'completed' : 'running')},
          image: 'unused', imageDigest: 'sha256:${'a'.repeat(64)}' }));
        if (${Boolean(options.invalidInventory)} && witness) rows.push(rows[0]);
        if (${Boolean(options.invalidImage)} && witness) rows[0].imageDigest = 'private-token-canary';
        process.stdout.write(JSON.stringify(rows));
      }
    `,
    );
    return callHelper(`
      PROJECT_ROOT="$3"
      NUKE_SUBMIT_LOG_DIR="$3"
      NUKE_CLEANUP_RECORD_DIR="$3/records"
      API_URL=http://unused
      TEST_RUN=1231
      NUKE_COUNT=300
      GITHUB_TOKEN=normal-token
      NUKE_FAIRNESS_USER=witness
      NUKE_INTERRUPT_AFTER_WITNESS=true
      NUKE_INTERRUPTION_ARMED=false
      NUKE_IS_LOCAL=true
      NUKE_USES_BUCKET_SYNC=false
      NUKE_CLASSIFICATION_EMITTED=true
      NUKE_PROVIDER=local
      NUKE_IMAGE=unused
      NUKE_RUNTIME_SEC=1
      NUKE_SUBMIT_TIMEOUT_SEC=5
      NUKE_CLEANUP_DRAIN_SEC=0
      NUKE_IDS=(nuke-1231-1 nuke-1231-2)
      NUKE_WITNESS_IDS=(${witnessIds.join(' ')})
      SUBMIT_TIMEOUT_CMD=$(command -v timeout || command -v gtimeout)
      nuke_db_run_with_timeout() { shift; "$@"; }
      cleanup_local_smolvm_resources() { :; }
      api_terminate() {
        if kill -0 -- "-$submit_pid" 2>/dev/null; then
          printf 'termination raced a live submit\\n' >> "$trace"
          return 1
        fi
        printf 'terminate:%s:%s\\n' "\${NUKE_CLEANUP_COHORT:-normal}" "$1" >> "$trace"
        ${options.cleanupFailure ? '[ "$1" != nuke-1231-1 ]' : ':'}
      }
      nuke_assert_workloads_vms_ended() { :; }
      nuke_install_cleanup_traps
      nuke_launch_submission submit_witness_one nuke-witness-1231-1 1
      submit_pid=$NUKE_SUBMIT_PID
      nuke_interrupt_after_witness nuke-witness-1231-1 "$submit_pid" || exit 8
      printf 'unexpected continuation\\n'
    `);
  }

  it('interrupts an admitted witness hold, records repeated TERM, and drains both cohort inventories after reaping', () => {
    const result = interruptAdmittedWitness();
    expect(result.status, result.stderr).toBe(143);
    expect(result.stdout).not.toContain('unexpected continuation');
    const record = (name: string) =>
      JSON.parse(readFileSync(join(fixtureDir, 'records', name), 'utf8'));
    const admitted = record('admitted-witness.json');
    expect(admitted).toMatchObject({
      kind: 'admitted-witness-wrapper-hold',
      admissionExitCode: 0,
      holdSeconds: 30,
    });
    expect(record('start.json')).toMatchObject({
      exitCode: 143,
      forcedRequested: true,
      forcedArmed: true,
    });
    expect(record('result.json')).toEqual({
      version: 1,
      exitCode: 143,
      cleanupExitCode: 0,
      repeatedTerm: true,
    });
    expect(record('submissions.json')).toEqual({
      version: 1,
      groupIds: [admitted.wrapperPid],
      remainingGroupIds: [],
    });
    expect(() => process.kill(-admitted.wrapperPid, 0)).toThrow();
    expect(record('interruption.json').activeIds).toEqual([
      'nuke-1231-1',
      'nuke-1231-2',
      'nuke-witness-1231-1',
    ]);
    expect(record('normal.json')).toMatchObject({
      cohort: 'normal',
      ids: ['nuke-1231-1', 'nuke-1231-2'],
      vmsEnded: true,
    });
    expect(record('witness.json')).toMatchObject({
      cohort: 'witness',
      ids: ['nuke-witness-1231-1'],
      vmsEnded: true,
    });
    expect(cleanupTrace()).toEqual([
      'terminate:normal:nuke-1231-1',
      'terminate:normal:nuke-1231-2',
      'terminate:witness:nuke-witness-1231-1',
    ]);
  });

  it.each([{ terminal: true }, { invalidInventory: true }])(
    'does not arm from unavailable active Workload evidence %j',
    (options) => {
      const result = interruptAdmittedWitness(options);
      expect(result.status, result.stderr).toBe(8);
      expect(
        JSON.parse(
          readFileSync(join(fixtureDir, 'records/start.json'), 'utf8'),
        ),
      ).toMatchObject({ exitCode: 8, forcedArmed: false });
      expect(
        JSON.parse(
          readFileSync(join(fixtureDir, 'records/result.json'), 'utf8'),
        ),
      ).toMatchObject({ repeatedTerm: false });
      expect(() =>
        readFileSync(join(fixtureDir, 'records/interruption.json'), 'utf8'),
      ).toThrow();
      expect(
        JSON.parse(
          readFileSync(join(fixtureDir, 'records/submissions.json'), 'utf8'),
        ).remainingGroupIds,
      ).toEqual([]);
      expect(readFileSync(join(fixtureDir, 'trace'), 'utf8')).toContain(
        'terminate:witness:nuke-witness-1231-1',
      );
    },
  );

  it('captures and drains a witness cohort larger than the normal workload count', () => {
    const result = interruptAdmittedWitness({ witnessCount: 301 });
    expect(result.status, result.stderr).toBe(143);
    const record = (name: string) =>
      JSON.parse(readFileSync(join(fixtureDir, 'records', name), 'utf8'));
    const witnessIds = Array.from(
      { length: 301 },
      (_, index) => `nuke-witness-1231-${index + 1}`,
    );
    for (const suffix of ['before-interrupt', 'inventory'])
      expect(record(`witness-${suffix}.json`).workloads).toEqual(
        witnessIds.map((id) => ({ id, state: 'running' })),
      );
    expect(record('witness.json')).toMatchObject({
      ids: witnessIds,
      terminationFailedIds: [],
      vmsEnded: true,
    });
    expect(record('result.json')).toMatchObject({
      exitCode: 143,
      cleanupExitCode: 0,
    });
  });

  it('retains the original TERM failure and raw cleanup failure independently', () => {
    const result = interruptAdmittedWitness({ cleanupFailure: true });
    expect(result.status, result.stderr).toBe(143);
    expect(
      JSON.parse(readFileSync(join(fixtureDir, 'records/result.json'), 'utf8')),
    ).toMatchObject({ exitCode: 143, cleanupExitCode: 1, repeatedTerm: true });
    expect(
      JSON.parse(readFileSync(join(fixtureDir, 'records/normal.json'), 'utf8')),
    ).toMatchObject({ terminationFailedIds: ['nuke-1231-1'], vmsEnded: true });
    expect(result.stderr).toContain(
      'Nuke cleanup failed (exit 1); original exit was 143',
    );
  });

  it('retains valid IDs and drains both cohorts when image metadata is malformed', () => {
    const result = interruptAdmittedWitness({ invalidImage: true });
    expect(result.status, result.stderr).toBe(143);
    const record = (name: string) =>
      JSON.parse(readFileSync(join(fixtureDir, 'records', name), 'utf8'));
    expect(record('result.json')).toMatchObject({
      exitCode: 143,
      cleanupExitCode: 0,
    });
    expect(record('normal-inventory-images.json').workloads).toHaveLength(2);
    expect(record('witness-inventory.json').workloads).toEqual([
      { id: 'nuke-witness-1231-1', state: 'running' },
    ]);
    expect(record('witness-inventory-images.json').workloads).toEqual([
      {
        id: 'nuke-witness-1231-1',
        image: 'unused',
        imageStatus: 'observed',
        imageDigest: null,
        digestStatus: 'invalid',
      },
    ]);
    expect(
      readFileSync(
        join(fixtureDir, 'records/witness-inventory-images.json'),
        'utf8',
      ),
    ).not.toContain('private-token-canary');
    expect(readFileSync(join(fixtureDir, 'trace'), 'utf8')).toContain(
      'terminate:witness:nuke-witness-1231-1',
    );
  });

  it('preserves the earlier cohort image observation and original exit when a later list fails', () => {
    const result = interruptAdmittedWitness({ laterInventoryFailure: true });
    expect(result.status, result.stderr).toBe(143);
    const record = (name: string) =>
      JSON.parse(readFileSync(join(fixtureDir, 'records', name), 'utf8'));
    expect(record('result.json')).toMatchObject({
      exitCode: 143,
      cleanupExitCode: 1,
    });
    expect(record('witness-before-interrupt-images.json').workloads).toEqual([
      {
        id: 'nuke-witness-1231-1',
        image: 'unused',
        imageStatus: 'observed',
        imageDigest: `sha256:${'a'.repeat(64)}`,
        digestStatus: 'observed',
      },
    ]);
    expect(record('witness.json')).toMatchObject({
      ids: ['nuke-witness-1231-1'],
      vmsEnded: true,
    });
    expect(record('normal.json')).toMatchObject({
      ids: ['nuke-1231-1', 'nuke-1231-2'],
      vmsEnded: true,
    });
    expect(() => record('witness-inventory-images.json')).toThrow();
    expect(`${result.stdout}${result.stderr}`).not.toContain(
      'private-token-canary',
    );
    expect(readFileSync(join(fixtureDir, 'trace'), 'utf8')).toContain(
      'terminate:witness:nuke-witness-1231-1',
    );
  });
});

describe('nuke-cleanup.sh syntax', () => {
  it('parses without error', () => {
    const result = spawnSync('bash', ['-n', helperPath], {
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
  });
});
