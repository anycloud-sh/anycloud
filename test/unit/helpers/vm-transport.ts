import type { VmTransport } from '../../../src/api/services/gateways/transport-contract.js';

/**
 * Build a VM transport that implements only what a test drives.
 *
 * Every call the test does not stub throws by name. A transport whose unused
 * half silently resolves lets a spec pass while the code under test takes a
 * path the spec never meant to allow — writing a file, streaming a command —
 * so the default is to fail loudly rather than to no-op.
 */
export function makeVmTransport(overrides: Partial<VmTransport>): VmTransport {
  const unstubbed = (call: string) => () => {
    throw new Error(`transport.${call} was not stubbed for this test`);
  };
  return {
    exec: unstubbed('exec'),
    execStream: unstubbed('execStream'),
    writeFile: unstubbed('writeFile'),
    ping: unstubbed('ping'),
    ...overrides,
  };
}
