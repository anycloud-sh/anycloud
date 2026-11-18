import type { ArtifactStore } from '../artifacts.js';
import type { ControllerEndpoint } from '../controller-session.js';
import type { ProcessRunner } from '../process.js';
import { WaitTimeoutError, Waiter } from '../wait.js';
import type { TargetHttpClient } from './http.js';

/** The container name the local controller runs under. */
const API_CONTAINER = 'anycloud-api';
const COMMAND_TIMEOUT_MS = 60_000;
const READY_TIMEOUT_MS = 120_000;
const READY_POLL_MS = 500;

export interface LocalApiRestartEvidence {
  /**
   * The controller's container id before and after. Equal ids prove its own
   * container was restarted, so recovery ran against the persisted checkpoint
   * rather than against a freshly created container's empty state.
   */
  readonly identityAfter: string;
  readonly identityBefore: string;
}

/**
 * Kills the local controller and starts it again. This is fault injection, not
 * lifecycle control: it makes the controller lose everything it held in memory
 * so that whatever the Service retains afterwards came from durable state.
 */
export class LocalApiRestarter {
  readonly #artifacts: Pick<ArtifactStore, 'json'>;
  readonly #commands: Pick<ProcessRunner, 'run'>;
  readonly #endpoint: Pick<ControllerEndpoint, 'snapshot'>;
  readonly #http: Pick<TargetHttpClient, 'get'>;

  constructor(dependencies: {
    readonly artifacts: Pick<ArtifactStore, 'json'>;
    readonly commands: Pick<ProcessRunner, 'run'>;
    readonly endpoint: Pick<ControllerEndpoint, 'snapshot'>;
    readonly http: Pick<TargetHttpClient, 'get'>;
  }) {
    this.#artifacts = dependencies.artifacts;
    this.#commands = dependencies.commands;
    this.#endpoint = dependencies.endpoint;
    this.#http = dependencies.http;
  }

  async restart(): Promise<LocalApiRestartEvidence> {
    const identityBefore = await this.#containerId();
    await this.#docker(
      ['kill', '--signal=KILL', API_CONTAINER],
      'local-api-kill',
    );
    await this.#docker(['start', API_CONTAINER], 'local-api-start');
    const identityAfter = await this.#containerId();
    await this.#awaitListening();
    const evidence: LocalApiRestartEvidence = {
      identityAfter,
      identityBefore,
    };
    await this.#artifacts.json('local-api-restart', evidence);
    return evidence;
  }

  async #containerId(): Promise<string> {
    return this.#docker(
      ['inspect', '--format', '{{.Id}}', API_CONTAINER],
      'local-api-container-id',
    );
  }

  async #docker(args: readonly string[], label: string): Promise<string> {
    const result = await this.#commands.run('docker', args, {
      label,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    if (result.exitCode !== 0 || result.timedOut || result.aborted) {
      throw new Error(
        `Local API restart: ${label} failed (exit ${String(result.exitCode)}, timeout ${String(result.timedOut)}, aborted ${String(result.aborted)})`,
      );
    }
    return result.stdout.trim();
  }

  /**
   * Any HTTP response means the controller is accepting connections again;
   * only a refused connection means it is still down. Waiting here keeps the
   * restart a completed fact, so no later stage has to treat a connection
   * error as retryable and risk burning its deadline on a controller that
   * never came back.
   */
  async #awaitListening(): Promise<void> {
    const snapshot = this.#endpoint.snapshot();
    if (!snapshot) {
      throw new Error('Local API restart: no controller endpoint is attached');
    }
    const url = new URL(snapshot.url);
    await new Waiter(new AbortController().signal)
      .for(
        'Local API restart',
        () => this.#http.get('local-api-restart-probe', url),
        {
          timeoutMs: READY_TIMEOUT_MS,
          intervalMs: READY_POLL_MS,
          probeError: { retry: () => true },
          unmet: () => undefined,
        },
      )
      .catch((error: unknown) => {
        if (!(error instanceof WaitTimeoutError)) throw error;
        throw new Error(
          `Local API restart: controller did not accept connections within ${String(READY_TIMEOUT_MS)}ms (${String(error.cause)})`,
        );
      });
  }
}
