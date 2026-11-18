import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'http';
import type { AddressInfo } from 'net';

/**
 * Shared plumbing for the RFC 0034 fake-provider servers. Each fake serves
 * exactly the endpoints its journeys exercise and answers anything else with
 * a loud 599 so a drifted request fails the test instead of passing against
 * an imagined response.
 */

export interface FakeCloudServer {
  url: string;
  /** One entry per request: "METHOD /path" plus the query action when set. */
  calls: string[];
  close: () => Promise<void>;
}

export async function readRequestBody(
  request: IncomingMessage,
): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function respondJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

export function respondXml(
  response: ServerResponse,
  status: number,
  body: string,
): void {
  response.writeHead(status, { 'content-type': 'text/xml' });
  response.end(body);
}

export function respondUnhandled(
  response: ServerResponse,
  detail: string,
): void {
  response.writeHead(599, { 'content-type': 'text/plain' });
  response.end(`Unhandled fake-cloud request: ${detail}`);
}

export async function listenOnLoopback(
  server: Server,
): Promise<{ url: string; close: () => Promise<void> }> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections?.();
      }),
  };
}

export function startHttpFake(
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    calls: string[],
  ) => Promise<void> | void,
): Promise<FakeCloudServer> {
  const calls: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    calls.push(`${request.method} ${url.pathname}`);
    Promise.resolve(handler(request, response, url, calls)).catch((error) => {
      respondUnhandled(response, (error as Error).message);
    });
  });
  return listenOnLoopback(server).then(({ url, close }) => ({
    url,
    calls,
    close,
  }));
}
