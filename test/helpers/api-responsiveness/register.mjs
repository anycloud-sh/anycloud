import { register, syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import childProcess from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

globalThis.apiResponsivenessGuardFailures = [];
function rejectBoundary(name) {
  return () => {
    globalThis.apiResponsivenessGuardFailures.push(name);
    throw new Error('Responsiveness fixture forbids ' + name);
  };
}
net.Socket.prototype.connect = rejectBoundary('outbound sockets');
globalThis.fetch = rejectBoundary('fetch');
for (const name of [
  'spawn',
  'spawnSync',
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
  'fork',
]) {
  childProcess[name] = rejectBoundary(name);
}
syncBuiltinESMExports();
register('./loader.mjs', import.meta.url, {
  data: {
    calculatorUrl: pathToFileURL(
      path.join(
        process.env.ANYCLOUD_BENCH_BUILD_DIR,
        'dist/api/services/cost-calculation/index.js',
      ),
    ).href,
    providerUrl: pathToFileURL(
      path.join(
        process.env.ANYCLOUD_BENCH_BUILD_DIR,
        'dist/api/services/provider-clients/aws.js',
      ),
    ).href,
    boundaryUrl: new URL('./billing-provider.mjs', import.meta.url).href,
  },
});
