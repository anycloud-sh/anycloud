/**
 * SSH Keepalive Integration Test
 *
 * Tests that SSH keepalive is configured to prevent idle connection timeouts.
 * Uses a Node.js TCP proxy that kills idle connections after 10 seconds,
 * simulating AWS NAT Gateway behavior (350s timeout in production).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SSHManager } from '../../src/api/services/gateways/ssh';
import { spawn } from 'child_process';
import path from 'path';
import {
  startSshdContainer,
  type SshdContainer,
} from './helpers/sshd-container';

describe('SSH Keepalive', () => {
  let ssh: SSHManager;
  let container: SshdContainer;
  let proxyProcess: ReturnType<typeof spawn> | null = null;
  const SSH_SERVER_PORT = 2224; // Direct SSH port
  const PROXY_PORT = 2223; // Proxy port with idle killer
  const IDLE_TIMEOUT_MS = 65000; // 65 seconds (longer than the 10s keepalive interval)

  beforeAll(async () => {
    console.log('Setting up SSH server + idle-killer proxy...');

    container = await startSshdContainer({
      tag: 'ssh-keepalive-test',
      port: SSH_SERVER_PORT,
    });

    // Start Node.js idle-killer proxy
    const proxyScript = path.join(__dirname, 'idle-killer-proxy.js');
    console.log(
      `Starting idle-killer proxy: localhost:${PROXY_PORT} -> localhost:${SSH_SERVER_PORT} (${IDLE_TIMEOUT_MS}ms timeout)`,
    );

    proxyProcess = spawn('node', [
      proxyScript,
      String(PROXY_PORT),
      String(SSH_SERVER_PORT),
      String(IDLE_TIMEOUT_MS),
    ]);

    proxyProcess.stdout?.on('data', (data: string | Buffer) => {
      console.log(data.toString().trim());
    });

    proxyProcess.stderr?.on('data', (data: string | Buffer) => {
      console.error(`[Proxy Error] ${data.toString().trim()}`);
    });

    // Wait for proxy to be ready
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Create SSH connection through proxy
    ssh = new SSHManager('127.0.0.1', container.privateKey, PROXY_PORT);

    console.log('Setup complete!');
    // Building the sshd image (apt install) is network-bound, so give the
    // whole setup generous headroom.
  }, 180000);

  afterAll(async () => {
    await SSHManager.closeConnection('127.0.0.1', PROXY_PORT);
    if (proxyProcess) {
      console.log('Stopping proxy...');
      proxyProcess.kill();
    }
    if (container) {
      console.log('Cleaning up container...');
      container.stop();
    }
  });

  it('should SUCCEED - keepalive prevents connection from being killed', async () => {
    console.log(`\nRunning 70-second sleep through idle-killer proxy...`);
    console.log(`Proxy kills idle connections after ${IDLE_TIMEOUT_MS}ms`);
    console.log(`SSH keepalive sends packets every 10s`);
    console.log(`Expected: Keepalive packets keep the connection alive`);

    const startTime = Date.now();
    const result = await ssh.exec('sleep 70', 1, false); // No retry
    const elapsed = Date.now() - startTime;

    console.log(`SUCCESS: Command completed in ${elapsed}ms`);
    console.log(`Exit code: ${result.code}`);

    // Should complete successfully after 70 seconds
    expect(result.code).toBe(0);
    expect(elapsed).toBeGreaterThanOrEqual(70000);
    expect(elapsed).toBeLessThan(75000); // Some buffer for execution time

    console.log('\nStressing pooled SSH connection with concurrent execs...');
    const stressStart = Date.now();
    const stressResults = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        ssh.exec(`echo start-${i}; sleep 1; echo done-${i}`, 1, false, 15000),
      ),
    );
    const stressElapsed = Date.now() - stressStart;

    for (const [i, stressResult] of stressResults.entries()) {
      expect(stressResult.code).toBe(0);
      expect(stressResult.stdout.trim().split('\n')).toEqual([
        `start-${i}`,
        `done-${i}`,
      ]);
    }
    expect(stressElapsed).toBeLessThan(5000);
  }, 90000);
});
