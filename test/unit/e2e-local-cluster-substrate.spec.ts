import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

import { CleanupStack } from '../integration/e2e/internal/cleanup.js';
import { StageProgress } from '../integration/e2e/internal/progress.js';
import {
  publishedKubeconfig,
  waitForKubeSystemIdentity,
} from '../integration/e2e/internal/substrates/local-cluster/cluster-host.js';
import { Waiter } from '../integration/e2e/internal/wait.js';

const certificateAuthorityData = Buffer.from(
  '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n',
).toString('base64');

describe('local cluster qualification substrate', () => {
  test('dumps container diagnostics through one channel with each state', () => {
    // Vitest buffers console.error and flushes it after direct stderr writes,
    // which put each container header under another container's log.
    const command = readFileSync(
      'test/integration/e2e/internal/substrates/local-cluster/command.ts',
      'utf8',
    );
    const body = command.slice(
      command.indexOf('export async function dumpLocalKubernetesDiagnostics'),
    );
    expect(body).not.toContain('console.error(');
    expect(body).toContain(
      'restarts={{.RestartCount}} exit={{.State.ExitCode}}',
    );
    const environment = readFileSync(
      'test/integration/e2e/internal/substrates/local-cluster/environment.ts',
      'utf8',
    );
    expect(environment).not.toContain('this.#host.captureDiagnostics()');
  });

  test('reports each cleanup step as it runs, with its duration', async () => {
    const lines: string[] = [];
    const stack = new CleanupStack((message) => lines.push(message));
    stack.defer('first', async () => undefined);
    stack.defer('second', async () => {
      throw new Error('boom');
    });
    await expect(stack.run()).rejects.toThrow('second: boom');
    expect(lines).toEqual([
      'cleanup: second',
      expect.stringMatching(/^cleanup: second failed in \d+s: boom$/u),
      'cleanup: first',
      expect.stringMatching(/^cleanup: first done in \d+s$/u),
    ]);
    const marks: string[] = [];
    new StageProgress((line) => marks.push(line)).mark('cluster registered');
    expect(marks[0]).toMatch(
      /^\[e2e \d{4}-\d{2}-\d{2}T[\d:.]+Z\] cluster registered\n$/u,
    );
  });

  test('dumps the cleanup phase of a failed run as well as the failure', () => {
    const environment = readFileSync(
      'test/integration/e2e/internal/substrates/local-cluster/environment.ts',
      'utf8',
    );
    expect(environment).toContain('{ since: this.#diagnosedAt }');
    const command = readFileSync(
      'test/integration/e2e/internal/substrates/local-cluster/command.ts',
      'utf8',
    );
    expect(command).toContain("['--since', options.since]");
  });

  test('publishes the K3s kubeconfig on one host-gateway URL and keeps its certificates', () => {
    const source = [
      'apiVersion: v1',
      'kind: Config',
      'clusters:',
      '- name: default',
      '  cluster:',
      '    server: https://127.0.0.1:6443',
      `    certificate-authority-data: ${certificateAuthorityData}`,
      'users:',
      '- name: default',
      '  user:',
      '    client-certificate-data: Y2VydA==',
      '    client-key-data: a2V5',
      'contexts:',
      '- name: default',
      '  context:',
      '    cluster: default',
      '    user: default',
      'current-context: default',
      '',
    ].join('\n');
    const published = publishedKubeconfig(source, 'https://172.17.0.1:41234');
    expect(published.certificateAuthorityData).toBe(certificateAuthorityData);
    const parsed = JSON.parse(published.kubeconfig) as {
      clusters: { cluster: { server: string } }[];
      users: { user: { 'client-certificate-data': string } }[];
    };
    expect(parsed.clusters[0].cluster.server).toBe('https://172.17.0.1:41234');
    expect(parsed.users[0].user['client-certificate-data']).toBe('Y2VydA==');
    expect(() =>
      publishedKubeconfig(
        source.replace('    client-certificate-data: Y2VydA==\n', ''),
        'https://172.17.0.1:41234',
      ),
    ).toThrow();
  });

  test('waits through the apiserver window in which kube-system does not exist yet before reading the identity', async () => {
    let reads = 0;
    const core = {
      readNamespace: async () => {
        reads += 1;
        if (reads <= 2) {
          throw Object.assign(new Error('namespaces "kube-system" not found'), {
            code: 404,
          });
        }
        return { metadata: { uid: 'uid-kube-system' } };
      },
    };
    const wait = new Waiter(new AbortController().signal);
    await expect(
      waitForKubeSystemIdentity(core, wait, 'local cluster x', {
        timeoutMs: 2_000,
        intervalMs: 5,
      }),
    ).resolves.toBe('uid-kube-system');
    expect(reads).toBe(3);

    // Anything but a 404 is a real failure, not a namespace still booting.
    await expect(
      waitForKubeSystemIdentity(
        {
          readNamespace: async () => {
            throw Object.assign(new Error('forbidden'), { code: 403 });
          },
        },
        wait,
        'local cluster y',
        { timeoutMs: 2_000, intervalMs: 5 },
      ),
    ).rejects.toThrow('forbidden');
    await expect(
      waitForKubeSystemIdentity(
        { readNamespace: async () => ({ metadata: {} }) },
        wait,
        'local cluster z',
        { timeoutMs: 20, intervalMs: 5 },
      ),
    ).rejects.toThrow('kube-system namespace not created yet');
  });
});
