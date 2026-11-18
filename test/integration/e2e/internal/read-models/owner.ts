import { cliArgs } from '../cli-surface.js';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import type { ArtifactStore } from '../artifacts.js';
import type { CleanupStack } from '../cleanup.js';
import { CliClient } from '../cli.js';
import type { FixtureFiles } from '../files.js';
import { ManagedProcess } from '../managed-process.js';
import type { ProcessRunner } from '../process.js';
import type { TargetHttpClient } from '../transports/http.js';
import type { CommandResult } from '../types.js';
import {
  assertHistoryInvariants,
  assertHistorySessionSelection,
  historyManifestSchema,
  historySessionCases,
  parseHistoryReady,
} from './history-records.js';
import { writeLocalApiToken } from '../../../helpers/local-api-token.js';

export interface BillingSettlementResult {
  readonly transactionInterruption: true;
  readonly atomicRecovery: true;
  readonly idempotentReplay: true;
  readonly responsive: true;
}

export interface LongHistoryResult {
  readonly historicalWorkloads: 3_700;
  readonly sessionForms: 5;
  readonly historyPreserved: true;
  readonly billingResponsive: true;
}

interface ReadModelOptions {
  readonly artifacts: ArtifactStore;
  readonly cleanup: CleanupStack;
  readonly commands: ProcessRunner;
  readonly files: FixtureFiles;
  readonly http: TargetHttpClient;
  readonly projectRoot: string;
  readonly signal: AbortSignal;
}

function assertCommand(result: CommandResult, budgetMs?: number): void {
  assert.equal(
    result.exitCode,
    0,
    `${result.args.join(' ')} failed: ${result.stderr}`,
  );
  assert.equal(result.signal, null);
  assert.equal(result.timedOut, false);
  assert.equal(result.aborted, false);
  assert.equal(result.outputTruncated, false);
  assert.equal(result.spawnError, undefined);
  if (budgetMs !== undefined)
    assert(
      result.durationMs <= budgetMs,
      `Read-model probe exceeded ${budgetMs}ms`,
    );
}

/** Local database/process ownership stays outside Workload lifecycle contracts. */
export class ReadModelProofs {
  readonly #options: ReadModelOptions;

  constructor(options: ReadModelOptions) {
    this.#options = options;
  }

  async billingSettlement(): Promise<BillingSettlementResult> {
    const directory = await this.#options.files.directory(
      'billing-settlement',
      { private: true },
    );
    await this.#billing('settlement', directory);
    return {
      transactionInterruption: true,
      atomicRecovery: true,
      idempotentReplay: true,
      responsive: true,
    };
  }

  async longHistory(): Promise<LongHistoryResult> {
    const { artifacts, cleanup, commands, files, http, projectRoot, signal } =
      this.#options;
    const directory = await files.directory('long-history', { private: true });
    const databasePath = path.join(directory, 'api.db');
    const manifestPath = path.join(directory, 'manifest.json');
    const environment = {
      ANYCLOUD_DIR: directory,
      SQLITE_PATH: databasePath,
      CIPHER_KEY: 'a'.repeat(64),
      IS_TEST: 'true',
      GITHUB_TOKEN: 'dummy-token-for-test',
      API_URL: undefined,
    };
    const api = new ManagedProcess<ReturnType<typeof parseHistoryReady>>(
      artifacts,
    );
    const processCleanup = cleanup.defer(
      'long-history API and database owner',
      () => api.stop(),
    );
    const report: Record<string, unknown> = {
      schemaVersion: 1,
      resourceMode: 'no-provision',
      cleanup: 'Not applicable',
      status: 'running',
    };
    const failures: unknown[] = [];
    try {
      assertCommand(
        await commands.run(
          process.execPath,
          [
            '--import',
            'tsx',
            'ci/seed.ts',
            'nuke-db',
            '3700',
            '--seed',
            'long-history-responsiveness',
            '--manifest',
            manifestPath,
          ],
          {
            env: environment,
            timeoutMs: 600_000,
            label: 'long-history-seed',
          },
        ),
      );
      const manifest = historyManifestSchema.parse(
        JSON.parse(await readFile(manifestPath, 'utf8')),
      );
      await artifacts.json('long-history-manifest', manifest);
      report.beforeRecovery = assertHistoryInvariants(
        await this.#historyChild('inspect', directory, environment),
      );
      report.afterRecovery = assertHistoryInvariants(
        await this.#historyChild('recover', directory, environment),
      );
      assert.deepEqual(report.beforeRecovery, report.afterRecovery);

      const readyPath = path.join(directory, 'api-ready.json');
      signal.throwIfAborted();
      const ready = await api.start({
        executable: process.execPath,
        args: [
          '--import',
          'tsx',
          this.#entry('history-serve-child.ts'),
          JSON.stringify({ action: 'serve', output: readyPath }),
        ],
        cwd: projectRoot,
        env: environment,
        label: 'long-history-api',
        readyPath,
        readyTimeoutMs: 20_000,
        parseReady: parseHistoryReady,
      });
      signal.throwIfAborted();
      const url = `http://127.0.0.1:${ready.port}`;
      const healthStartedAt = performance.now();
      const health = await http.get(
        'long-history-health',
        new URL('/health', url),
        { timeoutMs: 6_000 },
      );
      assert.equal(health.status, 200);
      assert.equal(health.body, 'ok');
      assert(performance.now() - healthStartedAt <= 6_000);
      // The CLI sends a loopback API the token `api start` would have written;
      // this in-process API authenticates the test GitHub stub instead.
      writeLocalApiToken(directory);
      const cli = new CliClient(
        commands,
        projectRoot,
        directory,
        url,
        'dummy-token-for-test',
        signal,
      );
      const cliOptions = { env: { IS_TEST: 'true' }, timeoutMs: 6_000 };
      assertCommand(
        await cli.run(cliArgs('list', { json: true }), {
          ...cliOptions,
          label: 'long-history-unfiltered-list',
        }),
        6_000,
      );
      assertCommand(
        await cli.run(
          cliArgs('status', { json: true }, [
            manifest.heavyStatusWorkloadIds[0],
          ]),
          { ...cliOptions, label: 'long-history-heavy-status' },
        ),
        6_000,
      );
      report.queries = await this.#historyChild(
        'queries',
        directory,
        environment,
        6_000,
      );
      const sessions: { label: string; rows: number; durationMs: number }[] =
        [];
      for (const selection of historySessionCases(manifest)) {
        const result = await cli.run(
          cliArgs('list', {
            limit: '1000',
            session: selection.form,
            json: true,
          }),
          {
            ...cliOptions,
            label: `long-history-session-${selection.label}`,
            recordArtifact: false,
          },
        );
        assertCommand(result, 6_000);
        sessions.push({
          label: selection.label,
          rows: assertHistorySessionSelection(
            JSON.parse(result.stdout),
            selection.expected,
          ),
          durationMs: result.durationMs,
        });
      }
      report.sessions = sessions;
      await api.captureDiagnostics();
      const log = await readFile(
        path.join(artifacts.directory, 'long-history-api-live.log'),
        'utf8',
      );
      assert.doesNotMatch(
        log,
        /"level":"(?:WARN|ERROR)"|Unhandled|fatal|SQLITE|OOM|out of memory/u,
        'History API emitted a warning/error signature',
      );

      // Stop and reap the sole live database owner before copying its file and
      // journal into the independent billing process harness.
      await api.stop();
      processCleanup.complete();
      assert.equal(api.active, false);
      report.databaseOwnerStoppedBeforeCopy = true;
      await this.#billing('responsiveness', directory, databasePath);
      report.status = 'complete';
      return {
        historicalWorkloads: 3_700,
        sessionForms: 5,
        historyPreserved: true,
        billingResponsive: true,
      };
    } catch (error) {
      failures.push(error);
      report.status = 'failed';
      report.failure = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      await this.#captureEvidence(failures, [
        () => api.captureDiagnostics('outcome'),
        () => artifacts.json('long-history-result', report),
      ]);
    }
  }

  #entry(name: string): string {
    return path.join(
      this.#options.projectRoot,
      'test/integration/e2e/internal/read-models',
      name,
    );
  }

  async #historyChild(
    action: 'inspect' | 'recover' | 'queries',
    directory: string,
    env: Readonly<Record<string, string | undefined>>,
    budgetMs = 600_000,
  ): Promise<unknown> {
    const output = path.join(directory, `${action}.json`);
    // Only `recover` needs the monitor's module graph; the budgeted probes
    // run through the light entry so the budget measures the read models.
    const entry =
      action === 'recover' ? 'history-recover-child.ts' : 'history-child.ts';
    const result = await this.#options.commands.run(
      process.execPath,
      [
        '--import',
        'tsx',
        this.#entry(entry),
        JSON.stringify({ action, output }),
      ],
      { env, timeoutMs: budgetMs, label: `long-history-${action}` },
    );
    assertCommand(result, budgetMs);
    const record: unknown = JSON.parse(await readFile(output, 'utf8'));
    await this.#options.artifacts.json(`long-history-${action}`, record);
    return record;
  }

  async #billing(
    kind: 'settlement' | 'responsiveness',
    directory: string,
    seedDatabase?: string,
  ): Promise<void> {
    const output = path.join(directory, `billing-${kind}`);
    const failures: unknown[] = [];
    try {
      const result = await this.#options.commands.run(
        process.execPath,
        [
          '--import',
          'tsx',
          this.#entry('billing-driver.ts'),
          JSON.stringify({
            kind,
            output,
            buildDir: this.#options.projectRoot,
            seedDatabase,
          }),
        ],
        {
          timeoutMs: 60 * 60 * 1_000,
          label: `billing-${kind}`,
        },
      );
      assertCommand(result);
      z.object({
        schemaVersion: z.literal(1),
        kind: z.literal(kind),
        status: z.literal('complete'),
        resourceMode: z.literal('no-provision'),
        cleanup: z.literal('Not applicable'),
      }).parse(
        JSON.parse(await readFile(path.join(output, 'result.json'), 'utf8')),
      );
    } catch (error) {
      failures.push(error);
      throw error;
    } finally {
      await this.#captureEvidence(failures, [
        () => this.#retainBillingRecords(output, `billing-${kind}`),
      ]);
    }
  }

  async #captureEvidence(
    operationFailures: readonly unknown[],
    captures: readonly (() => Promise<unknown>)[],
  ): Promise<void> {
    const outcomes = await Promise.allSettled(
      captures.map((capture) => capture()),
    );
    const evidenceFailures = outcomes
      .filter((outcome) => outcome.status === 'rejected')
      .map((outcome) => outcome.reason as unknown);
    if (evidenceFailures.length === 0) return;
    const failures = [...operationFailures, ...evidenceFailures];
    throw new AggregateError(
      failures,
      `Read-model evidence capture failed:\n- ${failures.map((error) => (error instanceof Error ? error.message : String(error))).join('\n- ')}`,
    );
  }

  async #retainBillingRecords(
    directory: string,
    prefix: string,
  ): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return;
      throw error;
    }
    for (const entry of entries) {
      const filename = path.join(directory, entry.name);
      const label = `${prefix}-${entry.name.replace(/\.(?:json|log)$/u, '')}`;
      if (entry.isDirectory())
        await this.#retainBillingRecords(filename, label);
      else if (
        entry.isFile() &&
        ['health.json', 'result.json', 'interruption.json'].includes(entry.name)
      ) {
        // Seed IPC includes synthetic credential identities; retain its
        // validated counts/fingerprint through the driver's final report.
        if (prefix.endsWith('-seed') && entry.name === 'result.json') continue;
        await this.#options.artifacts.json(
          label,
          JSON.parse(await readFile(filename, 'utf8')),
        );
      } else if (entry.isFile() && entry.name === 'child.log') {
        await this.#options.artifacts.text(
          label,
          await readFile(filename, 'utf8'),
        );
      }
    }
  }
}
