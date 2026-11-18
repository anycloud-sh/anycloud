import assert from 'node:assert/strict';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import dgram from 'node:dgram';
import childProcess from 'node:child_process';

/** Adapted from the shared API responsiveness registration boundary. */
export function installGuard({ port } = {}) {
  const violations = [];
  function reject(name) {
    violations.push(name);
    throw new Error('List spike forbids ' + name);
  }
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    let first = args[0];
    if (Array.isArray(first)) first = first[0];
    const host =
      typeof first === 'object' ? (first.host ?? first.hostname) : args[1];
    const targetPort = typeof first === 'object' ? first.port : first;
    if (
      !port ||
      host !== '127.0.0.1' ||
      Number(targetPort) !== port ||
      first?.path
    ) {
      return reject('outbound socket');
    }
    return connect.apply(this, args);
  };
  const fetch = globalThis.fetch;
  globalThis.fetch = (...args) => {
    const url = new URL(
      typeof args[0] === 'string' || args[0] instanceof URL
        ? args[0]
        : args[0].url,
    );
    if (!port || url.origin !== `http://127.0.0.1:${port}`)
      return reject('fetch');
    return fetch(...args);
  };
  dgram.createSocket = () => reject('datagram socket');
  for (const name of [
    'spawn',
    'spawnSync',
    'exec',
    'execSync',
    'execFile',
    'execFileSync',
    'fork',
  ]) {
    childProcess[name] = () => reject(name);
  }
  syncBuiltinESMExports();
  return {
    violations,
    rejectProviderOperations(providers) {
      for (const Provider of providers)
        for (const target of [Provider, Provider.prototype])
          for (const [name, descriptor] of Object.entries(
            Object.getOwnPropertyDescriptors(target),
          )) {
            if (
              name === 'constructor' ||
              typeof descriptor.value !== 'function'
            )
              continue;
            Object.defineProperty(target, name, {
              ...descriptor,
              value: () => reject(`provider ${Provider.name}.${name}`),
            });
          }
    },
    assertClean() {
      assert.deepEqual(
        violations,
        [],
        'A caught isolation violation invalidates the experiment',
      );
    },
  };
}
