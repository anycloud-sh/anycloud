import { createServer } from 'node:http';
import { KubeConfig, Observable } from '@kubernetes/client-node';
import { describe, expect, it } from 'vitest';
import { createKubernetesClients } from '../../../../src/api/services/kubernetes/client.js';
import { kubernetesRequestOptions } from '../../../../src/api/services/kubernetes/request-options.js';

describe('Kubernetes request cancellation', () => {
  it.each([
    ['TokenReview', 'headers'],
    ['TokenReview', 'body'],
    ['Pod observation', 'headers'],
    ['Pod observation', 'body'],
  ] as const)(
    'closes %s while waiting for response %s',
    async (operation, phase) => {
      let entered!: () => void;
      const received = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let disconnected!: () => void;
      const closed = new Promise<void>((resolve) => {
        disconnected = resolve;
      });
      const server = createServer((request, response) => {
        request.resume();
        response.once('close', disconnected);
        if (phase === 'body') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.write('{');
        }
        entered();
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Expected TCP listener');
      const config = new KubeConfig();
      config.loadFromOptions({
        clusters: [
          {
            name: 'fixture',
            server: `http://127.0.0.1:${address.port}`,
            skipTLSVerify: true,
          },
        ],
        users: [{ name: 'fixture' }],
        contexts: [{ name: 'fixture', cluster: 'fixture', user: 'fixture' }],
        currentContext: 'fixture',
      });
      const clients = createKubernetesClients(config);
      const controller = new AbortController();
      const options = kubernetesRequestOptions(controller.signal)!;
      let observedHeaders!: () => void;
      const headers = new Promise<void>((resolve) => {
        observedHeaders = resolve;
      });
      // Observe the generated client's body-read boundary without replacing its HTTP transport.
      options.middleware!.push({
        pre: (request) => new Observable(Promise.resolve(request)),
        post(response) {
          observedHeaders();
          return new Observable(Promise.resolve(response));
        },
      });
      try {
        const pending =
          operation === 'TokenReview'
            ? clients.authentication.createTokenReview(
                { body: { spec: { token: 'fixture-token' } } },
                options,
              )
            : clients.core.listNamespacedPod({ namespace: 'fixture' }, options);
        const rejected = expect(pending).rejects.toMatchObject({
          name: 'AbortError',
        });
        await received;
        if (phase === 'body') await headers;
        controller.abort(new Error('caller disconnected'));
        await rejected;
        await closed;
      } finally {
        controller.abort();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});
