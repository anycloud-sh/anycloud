import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  LOCAL_KUBERNETES_PROTOCOL_VERSION,
  localKubernetesChildConfigSchema,
  writeLocalKubernetesReadyRecord,
} from './protocol.js';
import { testAuthenticate } from '../../../../../helpers/test-authentication.js';

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const configPath = process.argv[2];
  invariant(configPath, 'usage: api-child.ts <config-path>');
  const config = localKubernetesChildConfigSchema.parse(
    JSON.parse(await readFile(configPath, 'utf8')) as unknown,
  );

  process.env.ANYCLOUD_DIR = path.join(config.stateRoot, 'anycloud-home');
  process.env.SQLITE_PATH = path.join(config.stateRoot, 'api.db');
  process.env.KUBECONFIG = path.join(
    config.stateRoot,
    'process-default-must-not-exist',
  );
  process.env.CIPHER_KEY = config.cipherKey;
  process.env.ANYCLOUD_WORKLOAD_API_URL = config.workloadApiUrl;
  process.env.IS_TEST = 'true';
  process.env.GITHUB_TOKEN = 'test-token';

  const [
    compositionModule,
    persistenceModule,
    monitorModule,
    serverModule,
    constantsModule,
    testIdentityModule,
  ] = await Promise.all([
    import('../../../../../../src/api/composition.js'),
    import('../../../../../../src/api/services/persistence.js'),
    import('../../../../../../src/api/services/monitor.js'),
    import('../../../../../../src/api/server.js'),
    import('./constants.js'),
    import('../../../../../../src/api/services/test-identity.js'),
  ]);

  await persistenceModule.initializePersistence();
  const persistence = persistenceModule.getPersistence();
  // The fixture's K3s is this API's cluster: recorded before serving as the
  // hosted API records itself, with the installer-kind connection the fixture
  // minted (a real cluster binds it during creation).
  const recorded = await persistence.clusters.recordSelf({
    id: constantsModule.clusterLocalClusterId,
    ownerUserId: testIdentityModule.TEST_USER_ID,
    name: config.cluster.name,
    kubernetesIdentity: config.cluster.kubernetesIdentity,
    connection: config.cluster.connection,
  });
  invariant(
    recorded !== 'identity-mismatch',
    'local cluster database records another cluster identity',
  );

  const rpcDomains = compositionModule.createApiRpcDomains();
  const app = serverModule.createApp({
    authenticate: testAuthenticate,
    resolveRpcDomains: () => rpcDomains,
  });
  const apiServer = app.listen(config.apiPort, '0.0.0.0');
  await new Promise<void>((resolve, reject) => {
    apiServer.once('listening', resolve);
    apiServer.once('error', reject);
  });
  apiServer.keepAliveTimeout = 0;
  await monitorModule.startBackgroundServices();

  await writeLocalKubernetesReadyRecord(config.readyPath, {
    version: LOCAL_KUBERNETES_PROTOCOL_VERSION,
    launchNonce: config.launchNonce,
    pid: process.pid,
    port: config.apiPort,
  });

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await new Promise<void>((resolve, reject) => {
      apiServer.close((error) => (error ? reject(error) : resolve()));
    });
    await monitorModule.stopBackgroundServices();
  };
  process.once('SIGTERM', () => {
    void stop().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(error);
        process.exit(1);
      },
    );
  });
  process.once('SIGINT', () => {
    void stop().then(() => process.exit(0));
  });
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
