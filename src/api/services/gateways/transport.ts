/**
 * VM command-transport seam.
 *
 * Consumers (DockerManager, SupervisorManager, vm-initializer, host-startup) depend on
 * the `VmTransport` interface and obtain instances via `createTransport()` rather
 * than constructing `SSHManager` directly. This lets the SSH implementation be
 * swapped for a fake in tests without monkeypatching the `SSHManager` class or its
 * module. Mirrors `createComputeProvider()` in cloud-config.ts (the cloud-gateway
 * factory).
 *
 * The interface is intentionally limited to the instance surface callers use:
 * command execution, stdin-backed file writes, and reachability checks. SSH key
 * generation and connection teardown remain static methods on `SSHManager`
 * (`generateKeypair`, `derivePublicKey`, `closeConnection`) and are not part of
 * the per-VM transport.
 */

import { SSHManager } from './ssh.js';
import type { VmTransport } from './transport-contract.js';

/** Construct the platform transport used by monitors and VM lifecycle work. */
export function createTransport(
  host: string,
  privateKey: string,
  port?: number,
  username?: string,
): VmTransport {
  return new SSHManager(host, privateKey, port, username);
}

/** Construct the lazy transport used by user-controlled exec and log streams. */
export function createUserTransport(
  host: string,
  privateKey: string,
  port?: number,
  username?: string,
): VmTransport {
  return new SSHManager(host, privateKey, port, username, 'user');
}
