import { LOCAL_SMOLVM_CONTRACT } from '../../../../../src/api/services/gateways/local-smolvm-contract.js';

import type { ArtifactStore } from '../artifacts.js';
import type {
  LocalSmolvmServeAbsenceObservation,
  LocalSmolvmServeReadyObservation,
  ServeHostAbsence,
} from '../targets/serve-types.js';
import { isRecord } from '../types.js';
import type { TargetHttpClient } from './http.js';
import { ownedSmolvmMachines, smolvmGuestPort } from './local-smolvm.js';

/** The guest port a Local Service publishes its workload on. */
const GUEST_HTTP_PORT = 80;
const GUEST_SSH_PORT = 22;

type ServeHttp = Pick<TargetHttpClient, 'get' | 'post'>;

/**
 * Reads the two facts the Local substrate owns: the microVM that backs a
 * Service, and whether the ports it forwarded still listen after teardown. It
 * owns no lifecycle policy and decides no outcome.
 */
export class LocalSmolvmServeTransport {
  readonly #artifacts: Pick<ArtifactStore, 'json'>;
  readonly #http: ServeHttp;
  readonly #smolvmUrl = new URL(LOCAL_SMOLVM_CONTRACT.baseUrl);

  constructor(artifacts: Pick<ArtifactStore, 'json'>, http: ServeHttp) {
    this.#artifacts = artifacts;
    this.#http = http;
  }

  async observeReady(
    workloadId: string,
  ): Promise<LocalSmolvmServeReadyObservation> {
    const machines = await ownedSmolvmMachines(
      this.#http,
      this.#smolvmUrl,
      workloadId,
    );
    const machine = machines[0];
    const ready = machine?.state === 'running';
    const sshHostPort = ready ? smolvmGuestPort(machine, GUEST_SSH_PORT) : 0;
    const httpHostPort = ready ? smolvmGuestPort(machine, GUEST_HTTP_PORT) : 0;
    const observation: LocalSmolvmServeReadyObservation = {
      kind: 'local-smolvm',
      guestContainerId: ready
        ? await this.#guestContainerId(machine.name, workloadId)
        : '',
      httpHostPort,
      machineCount: machines.length,
      machineName: machine?.name ?? '',
      machineState: machine?.state ?? '',
      responseBody: httpHostPort ? await this.#body(httpHostPort) : '',
      sshHostPort,
    };
    await this.#artifacts.json('local-smolvm-serve-ready', observation);
    return observation;
  }

  async observeAbsent(
    workloadId: string,
    hosts: readonly { readonly cloudId: string }[],
    forwardedPorts: readonly number[],
    deadlineAt?: number,
  ): Promise<LocalSmolvmServeAbsenceObservation> {
    const machines = await ownedSmolvmMachines(
      this.#http,
      this.#smolvmUrl,
      workloadId,
      { deadlineAt },
    );
    const remaining = new Set(machines.map((machine) => machine.name));
    const openForwardedPorts: number[] = [];
    for (const port of forwardedPorts) {
      if (await this.#listening(port, deadlineAt))
        openForwardedPorts.push(port);
    }
    const observation: LocalSmolvmServeAbsenceObservation = {
      kind: 'local-smolvm',
      hosts: hosts.map(
        (host): ServeHostAbsence => ({
          cloudId: host.cloudId,
          diagnostic: remaining.has(host.cloudId) ? 'still owned' : 'removed',
          presence: remaining.has(host.cloudId) ? 'present' : 'absent',
        }),
      ),
      openForwardedPorts,
    };
    await this.#artifacts.json('local-smolvm-serve-absence', observation);
    return observation;
  }

  /**
   * The workload container is named for the workload, so its identity proves
   * recovery adopted the original container rather than starting a new one.
   */
  async #guestContainerId(
    machineName: string,
    workloadId: string,
  ): Promise<string> {
    const response = await this.#http.post(
      'local-smolvm-serve-guest-container',
      new URL(
        `/api/v1/machines/${encodeURIComponent(machineName)}/exec`,
        this.#smolvmUrl,
      ),
      {
        // argv form, not a shell string: the workload id is never parsed as
        // shell syntax, and a missing container is already an exit code.
        command: ['docker', 'inspect', '--format', '{{.Id}}', workloadId],
        timeoutSecs: 10,
      },
      { headers: { 'Content-Type': 'application/json' } },
    );
    if (response.status !== 200 || !isRecord(response.body)) return '';
    const { exitCode, stdout } = response.body;
    return exitCode === 0 && typeof stdout === 'string' ? stdout.trim() : '';
  }

  async #body(port: number): Promise<string> {
    try {
      const response = await this.#http.get(
        'local-smolvm-serve-endpoint',
        new URL(`http://127.0.0.1:${String(port)}`),
        { timeoutMs: 5_000 },
      );
      if (response.status !== 200) return '';
      return typeof response.body === 'string'
        ? response.body
        : (JSON.stringify(response.body) ?? '');
    } catch {
      return '';
    }
  }

  async #listening(port: number, deadlineAt?: number): Promise<boolean> {
    try {
      await this.#http.get(
        'local-smolvm-serve-port-probe',
        new URL(`http://127.0.0.1:${String(port)}`),
        { timeoutMs: 2_000, deadlineAt, redirect: 'error' },
      );
      return true;
    } catch (error) {
      // Only a refused connection proves a closed port. Cancellation, a
      // timeout, malformed HTTP, or failed evidence writes remain failures.
      const seen = new Set<unknown>();
      let cause: unknown = error;
      while (isRecord(cause) && !seen.has(cause)) {
        if (cause.code === 'ECONNREFUSED') return false;
        seen.add(cause);
        cause = cause.cause;
      }
      throw error;
    }
  }
}
