import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import {
  claudeCapabilityError,
  codexSetupCapabilityError,
} from '../../benchmarks/agent-discovery/capabilities.ts';
import {
  claudeArguments,
  codexConfigArguments,
} from '../../benchmarks/agent-discovery/cases.ts';
import { isTerminalState, WorkloadState } from '../../src/shared/workload.js';
import {
  AWS_IMPORT_READINESS_TIMEOUT_MS,
  cleanupAWSOnboardingUser,
  createAWSImportFixture,
  createBootstrapAWSContext,
  disposeBootstrapAWSContext,
  managedCredentialName,
  runAdminAWS,
  type BootstrapAWSContext,
} from './credentials-onboarding/aws/admin.js';
import { retryUntilDeadline } from './credentials-onboarding/common/deadline-retry.js';

// S1, run locally: a fresh coding agent follows SKILL.md from an empty
// HOME to a completed public-image Job on AWS, through the released installer
// and a local API. The agent owns submission, so this is not an RFC 0017
// workload contract. Each session runs in a fresh privileged container with
// its own Docker daemon; see benchmarks/agent-discovery/README.md. Paid and
// opt-in: `yarn test:agent-onboarding` sets ANYCLOUD_AGENT_ONBOARDING=1.
const BUILD_TIMEOUT_MS = 10 * 60_000;
const AGENT_TIMEOUT_MS = 25 * 60_000;
const JOB_TIMEOUT_MS = 15 * 60_000;
const NATIVE_CLEANUP_TIMEOUT_MS = 10 * 60_000;
// The Job's own cleanup, then the final sweep, each get one native budget.
// The margin covers the unbudgeted steps: Docker readiness, copies and IAM calls.
const TEST_TIMEOUT_MS =
  AWS_IMPORT_READINESS_TIMEOUT_MS +
  BUILD_TIMEOUT_MS +
  AGENT_TIMEOUT_MS +
  JOB_TIMEOUT_MS +
  2 * NATIVE_CLEANUP_TIMEOUT_MS +
  10 * 60_000;
const IMAGE = 'hello-world';
const HOME = '/home/agent';
const CHECKOUT_SKILL = '/opt/anycloud-skill/SKILL.md';

// Pinned CLI versions and models, so every run uses the same agent.
const PINS = {
  claude: { version: '2.1.269', model: 'claude-sonnet-5' },
  codex: { version: '0.154.0', model: 'gpt-6-astra' },
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function docker(args: string[], input?: string, timeout = 120_000): string {
  const result = spawnSync('docker', args, {
    input,
    encoding: 'utf8',
    timeout,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(
      `docker ${args[0]} failed: ${result.error?.message ?? result.stderr}`,
    );
  return result.stdout;
}

/** The developer's own agent login, and the secret values to scrub. */
function agentLogin(agent: 'claude' | 'codex') {
  if (agent === 'claude') {
    const token = required('CLAUDE_CODE_OAUTH_TOKEN');
    return { env: { CLAUDE_CODE_OAUTH_TOKEN: token }, secrets: [token] };
  }
  if (process.env.OPENAI_API_KEY)
    return {
      env: { CODEX_API_KEY: process.env.OPENAI_API_KEY },
      secrets: [process.env.OPENAI_API_KEY],
    };
  const auth = readFileSync(
    join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json'),
    'utf8',
  );
  const secrets: string[] = [];
  JSON.parse(auth, (_, value: unknown) => {
    if (typeof value === 'string' && value.length >= 16) secrets.push(value);
    return value;
  });
  return { env: {}, secrets, auth };
}

interface ListedWorkload {
  id: string;
  workloadType: string;
  state: WorkloadState;
  image: string | null;
}

/**
 * Instances and volumes AWS holds with one tag, in every region: the Job's
 * `anycloud_deployment`, or the agent's API identity on everything it launched.
 */
async function nativeLeftovers(
  admin: BootstrapAWSContext,
  tag: string,
  value: string,
) {
  const query = async (args: string[], query: string) =>
    JSON.parse(
      await runAdminAWS(admin, [...args, '--query', query, '--output', 'json']),
    ) as string[][];
  const filter = `Name=tag:${tag},Values=${value}`;
  const regions = (
    await query(['ec2', 'describe-regions'], 'Regions[].[RegionName]')
  ).flat();
  const found = await Promise.all(
    regions.map(async (region) => {
      const where = ['--region', region, '--filters', filter];
      return {
        instances: await query(
          ['ec2', 'describe-instances', ...where],
          'Reservations[].Instances[].[InstanceId, State.Name]',
        ),
        volumes: (
          await query(
            ['ec2', 'describe-volumes', ...where],
            'Volumes[].[VolumeId]',
          )
        ).flat(),
      };
    }),
  );
  const instances = found.flatMap((f) => f.instances);
  return {
    instancesSeen: instances.length,
    live: instances
      .filter(([, state]) => state !== 'terminated')
      .map(([id]) => id),
    volumes: found.flatMap((f) => f.volumes),
  };
}

const awaitNativeCleanup = (
  admin: BootstrapAWSContext,
  tag: string,
  value: string,
) =>
  retryUntilDeadline(
    async () => {
      const leftovers = await nativeLeftovers(admin, tag, value);
      if (leftovers.live.length || leftovers.volumes.length)
        throw new Error(
          `AWS still holds ${tag}=${value} resources: ${JSON.stringify(leftovers)}`,
        );
      return leftovers;
    },
    {
      deadline: Date.now() + NATIVE_CLEANUP_TIMEOUT_MS,
      initialDelayMs: 10_000,
      maxDelayMs: 30_000,
    },
  );

/** The identity the agent's local API stamps on everything it launches. */
function apiIdentity(container: string): string | undefined {
  const copy = mkdtempSync(join(tmpdir(), 'agent-onboarding-db-'));
  try {
    for (const file of ['api.db', 'api.db-wal'])
      spawnSync('docker', [
        'cp',
        `${container}:${HOME}/.anycloud/${file}`,
        join(copy, file),
      ]);
    if (!existsSync(join(copy, 'api.db'))) return undefined;
    const db = new Database(join(copy, 'api.db'));
    try {
      const row = db
        .prepare("SELECT value FROM _metadata WHERE key = 'api_identity'")
        .get() as { value: string } | undefined;
      return row && /[0-9a-f]{32}/.exec(row.value)?.[0];
    } finally {
      db.close();
    }
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

describe.each(['claude', 'codex'] as const)('%s onboarding', (agent) => {
  it(
    `reaches a completed ${IMAGE} Job from SKILL.md alone`,
    async () => {
      // Fail, not skip, outside the opt-in script: watch mode and IDE gutters
      // must never launch a paid agent session.
      required('ANYCLOUD_AGENT_ONBOARDING');
      const output = join(
        '.context/agent-onboarding',
        `${agent}-${new Date().toISOString().replace(/[:.]/g, '-')}`,
      );
      mkdirSync(output, { recursive: true });
      const login = agentLogin(agent);
      const model = PINS[agent].model;
      const versions = {
        CLAUDE_CODE_VERSION: PINS.claude.version,
        CODEX_VERSION: PINS.codex.version,
      };
      const image = `anycloud-agent-onboarding:${versions.CLAUDE_CODE_VERSION}-${versions.CODEX_VERSION}`;
      let id = '';
      // The agent runs as a non-root user, as on a developer's machine.
      const exec = (args: string[], input?: string, user = 'agent') =>
        docker(
          ['exec', '-i', '--user', user, '-e', `HOME=${HOME}`, id, ...args],
          input,
        );
      const write = (path: string, contents: string, user = 'agent') =>
        exec(
          ['sh', '-c', `mkdir -p "$(dirname ${path})" && cat > ${path}`],
          contents,
          user,
        );
      // Wherever the documented installer put it, as a new shell would find it.
      const resolveAnycloud = () =>
        spawnSync('docker', [
          ...['exec', '--user', 'agent', '-e', `HOME=${HOME}`, id, 'sh', '-c'],
          'PATH="$HOME/.local/bin:$PATH" command -v anycloud',
        ])
          .stdout?.toString()
          .trim();
      const anycloud = (...args: string[]) => {
        const binary = resolveAnycloud();
        if (!binary) throw new Error('The agent never installed anycloud.');
        return exec([binary, ...args]);
      };
      const workloads = () =>
        JSON.parse(anycloud('list', '--json')) as ListedWorkload[];

      // Cloud access as a user has it: a durable AWS profile for an identity
      // holding only the published AnycloudAccess policy.
      const admin = await createBootstrapAWSContext();
      const name = managedCredentialName('onboarding', String(Date.now()));
      const errors: unknown[] = [];
      const secrets = [...login.secrets];
      try {
        const key = await createAWSImportFixture(admin, name, 'onboarding');
        secrets.push(key.accessKeyId, key.secretAccessKey);
        docker(
          [
            'build',
            '--tag',
            image,
            ...Object.entries(versions).flatMap(([arg, value]) => [
              '--build-arg',
              `${arg}=${value}`,
            ]),
            '-',
          ],
          readFileSync(
            'test/integration/fixtures/agent-onboarding.Dockerfile',
            'utf8',
          ),
          BUILD_TIMEOUT_MS,
        );
        id = docker(['run', '--detach', '--privileged', image]).trim();
        await retryUntilDeadline(
          () => Promise.resolve(exec(['docker', 'info'])),
          {
            deadline: Date.now() + 60_000,
            initialDelayMs: 1_000,
            maxDelayMs: 5_000,
          },
        );
        expect(resolveAnycloud()).toBe('');
        write(
          `${HOME}/.aws/credentials`,
          `[default]\naws_access_key_id = ${key.accessKeyId}\naws_secret_access_key = ${key.secretAccessKey}\n`,
        );
        if (login.auth) write(`${HOME}/.codex/auth.json`, login.auth);
        let skill = 'https://anycloud.sh/SKILL.md';
        if (process.env.ONBOARDING_SKILL === 'checkout') {
          write(
            CHECKOUT_SKILL,
            readFileSync('anycloud-skills/skills/anycloud/SKILL.md', 'utf8'),
            'root',
          );
          skill = CHECKOUT_SKILL;
        }
        const prompt = `set up ${skill}, then run ${IMAGE} as a Job`;
        const features =
          agent === 'codex'
            ? exec([
                'env',
                `CODEX_HOME=${HOME}/.codex`,
                'codex',
                'features',
                'list',
                ...codexConfigArguments('setup'),
              ])
            : '';
        writeFileSync(join(output, 'features.txt'), features);
        const session =
          agent === 'claude'
            ? {
                env: {
                  CLAUDE_CONFIG_DIR: `${HOME}/.claude-config`,
                  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
                },
                args: [
                  'claude',
                  ...claudeArguments('setup', ''),
                  '--model',
                  model,
                ],
              }
            : {
                env: { CODEX_HOME: `${HOME}/.codex` },
                args: [
                  ...['codex', 'exec', '--json', '--skip-git-repo-check'],
                  ...[
                    '--dangerously-bypass-approvals-and-sandbox',
                    '-m',
                    model,
                  ],
                  ...['-c', 'model_reasoning_effort="medium"'],
                  ...codexConfigArguments('setup'),
                  '-',
                ],
              };
        // The in-container `timeout` kills the agent itself; killing only the
        // `docker exec` client would leave it running. Credentials pass by
        // name, so they never appear in a process's arguments.
        const child = spawn(
          'docker',
          [
            ...['exec', '-i', '--user', 'agent', '-w', `${HOME}/work`],
            ...['-e', `HOME=${HOME}`],
            ...Object.entries(session.env).flatMap(([key, value]) => [
              '-e',
              `${key}=${value}`,
            ]),
            ...Object.keys(login.env).flatMap((key) => ['-e', key]),
            id,
            ...['timeout', '--signal=KILL', `${AGENT_TIMEOUT_MS / 1000}`],
            ...session.args,
          ],
          {
            env: { ...process.env, ...login.env },
            stdio: [
              'pipe',
              openSync(join(output, 'transcript.jsonl'), 'w'),
              openSync(join(output, 'stderr.txt'), 'w'),
            ],
            timeout: AGENT_TIMEOUT_MS + 60_000,
            killSignal: 'SIGKILL',
          },
        );
        child.stdin?.end(prompt);
        const [exitCode, signal] = (await once(child, 'exit')) as [
          number | null,
          NodeJS.Signals | null,
        ];
        const timedOut = exitCode === 137 || signal !== null;
        const execution = { agent, model, image, prompt, exitCode, signal };
        writeFileSync(
          join(output, 'execution.json'),
          `${JSON.stringify({ ...execution, timedOut }, null, 2)}\n`,
        );
        if (timedOut)
          throw new Error(`${agent} ran past ${AGENT_TIMEOUT_MS / 60_000} min`);
        const events = readFileSync(join(output, 'transcript.jsonl'), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        const capabilityError =
          agent === 'claude'
            ? claudeCapabilityError(events, 'setup', '')
            : codexSetupCapabilityError(features, events);
        writeFileSync(
          join(output, 'execution.json'),
          `${JSON.stringify({ ...execution, timedOut, capabilityError }, null, 2)}\n`,
        );
        expect(capabilityError).toBeNull();

        const job = workloads().find(
          (w) => w.workloadType === 'job' && w.image?.includes(IMAGE),
        );
        expect(job, `the agent submitted no ${IMAGE} Job`).toBeDefined();
        const state = await retryUntilDeadline(
          () => {
            const { workload } = JSON.parse(
              anycloud('status', job!.id, '--json'),
            ) as { workload: { state: WorkloadState } };
            if (!isTerminalState(workload.state))
              throw new Error(`${job!.id} is ${workload.state}`);
            return Promise.resolve(workload.state);
          },
          {
            deadline: Date.now() + JOB_TIMEOUT_MS,
            initialDelayMs: 10_000,
            maxDelayMs: 30_000,
          },
        );
        expect(state).toBe(WorkloadState.Completed);
        const native = await awaitNativeCleanup(
          admin,
          'anycloud_deployment',
          job!.id,
        );
        expect(native.instancesSeen).toBeGreaterThan(0);
        writeFileSync(
          join(output, 'result.json'),
          `${JSON.stringify({ job: job!.id, state, native }, null, 2)}\n`,
        );
      } catch (error) {
        errors.push(error);
      } finally {
        if (id) {
          // Stop the agent before cleanup, so it can't launch anything more.
          spawnSync('docker', ['exec', id, 'pkill', '-KILL', '-u', 'agent']);
          try {
            for (const w of resolveAnycloud() ? workloads() : [])
              if (!isTerminalState(w.state)) anycloud('terminate', w.id);
          } catch (error) {
            errors.push(error);
          }
          // Check AWS directly, whether or not the agent's API still answers.
          try {
            const identity = apiIdentity(id);
            if (identity)
              await awaitNativeCleanup(admin, 'anycloud_owner_api', identity);
          } catch (error) {
            errors.push(error);
          }
          try {
            secrets.push(
              exec([
                'sh',
                '-c',
                `cat ${HOME}/.anycloud/local-api-token 2>/dev/null || true`,
              ]),
            );
            // Removes the inner daemon, its API container and the session HOME.
            docker(['rm', '--force', '--volumes', id]);
          } catch (error) {
            errors.push(error);
          }
        }
        try {
          await cleanupAWSOnboardingUser(
            admin,
            `anycloud-${name}`,
            'onboarding',
          );
          await disposeBootstrapAWSContext(admin);
        } catch (error) {
          errors.push(error);
        }
        const account = /arn:aws:iam::(\d{12}):/.exec(admin.bootstrapArn)?.[1];
        for (const file of readdirSync(output)) {
          let text = readFileSync(join(output, file), 'utf8');
          for (const secret of [...secrets, account])
            if (secret?.trim())
              text = text.replaceAll(secret.trim(), '[REDACTED]');
          writeFileSync(join(output, file), text);
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length)
        throw new AggregateError(
          errors,
          `${agent} onboarding and cleanup failed`,
        );
    },
    TEST_TIMEOUT_MS,
  );
});
