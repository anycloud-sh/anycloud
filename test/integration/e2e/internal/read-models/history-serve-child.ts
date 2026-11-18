import assert from 'node:assert/strict';

import { createApp } from '../../../../../src/api/server.js';
import { testAuthenticate } from '../../../../helpers/test-authentication.js';
import {
  historyDatabase,
  parseHistoryChildOptions,
  writeReadyRecord,
} from './history-probes.js';

// This sole API/DB owner starts no lifecycle monitors and binds only loopback.
// Loading the API is why this is its own entry.
const options = parseHistoryChildOptions(['serve']);
await historyDatabase();
const server = createApp({ authenticate: testAuthenticate }).listen(
  0,
  '127.0.0.1',
  () => {
    const address = server.address();
    assert(address && typeof address !== 'string');
    void writeReadyRecord(
      options.output,
      JSON.stringify({ pid: process.pid, port: address.port }),
    ).catch((error: unknown) => {
      console.error(error);
      server.close(() => {
        process.exitCode = 1;
      });
    });
  },
);
const stop = (): void => {
  server.close(() => {
    process.exit(0);
  });
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
