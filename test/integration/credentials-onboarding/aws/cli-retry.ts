import { execFile } from 'child_process';
import { createHash, generateKeyPairSync } from 'crypto';
import { once } from 'events';
import { createServer, request as httpRequest, type Server } from 'http';
import type { AddressInfo } from 'net';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import {
  awsOperator,
  runAWSCLI,
  type AWSOperator,
} from '../../../../src/cli/services/credential-bootstrap/aws-cli-runner.js';

/** Real CLI, dummy credentials, and a loopback peer that loses mutation replies. */
export async function probeAWSMutationRetry(
  command: string,
  failure: string,
): Promise<{ requests: string[]; error: unknown; output?: string }> {
  return probeAWSRetry(command, failure, false);
}

export async function probeAWSReadRetry(
  failure: string,
): Promise<{ requests: string[]; error: unknown; output?: string }> {
  return probeAWSRetry('get-user', failure, true);
}

async function probeAWSRetry(
  command: string,
  failure: string,
  recoverRead: boolean,
): Promise<{ requests: string[]; error: unknown; output?: string }> {
  const root = await mkdtemp(join(tmpdir(), 'anycloud-aws-retry-'));
  const requests: string[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      requests.push(new URLSearchParams(body).get('Action') ?? 'missing');
      if (recoverRead && requests.length > 1) {
        response.writeHead(200, { 'content-type': 'text/xml' });
        response.end(
          '<GetUserResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/"><GetUserResult><User><Path>/</Path><UserName>anycloud-loopback</UserName><UserId>AIDALOOPBACKONLY</UserId><Arn>arn:aws:iam::123456789012:user/anycloud-loopback</Arn><CreateDate>2026-09-21T00:00:00Z</CreateDate></User></GetUserResult><ResponseMetadata><RequestId>loopback</RequestId></ResponseMetadata></GetUserResponse>',
        );
      } else if (failure === 'lost-response') {
        // The mutation was accepted, but the connection dies before a reply.
        response.destroy();
      } else {
        response.writeHead(500, { 'content-type': 'text/xml' });
        response.end(
          '<ErrorResponse><Error><Type>Receiver</Type><Code>ServiceFailure</Code><Message>simulated failure</Message></Error><RequestId>loopback</RequestId></ErrorResponse>',
        );
      }
    });
  });
  try {
    const config = join(root, 'config');
    const credentials = join(root, 'credentials');
    await writeFile(
      config,
      '[profile operator]\nregion = us-east-1\nmax_attempts = 9\nretry_mode = adaptive\n',
    );
    await writeFile(
      credentials,
      '[operator]\naws_access_key_id = AKIALOOPBACKONLY00000\naws_secret_access_key = loopback-secret-not-a-real-credential\n',
      { mode: 0o600 },
    );
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const operator = awsOperator('operator', {
      ...process.env,
      AWS_CONFIG_FILE: config,
      AWS_SHARED_CREDENTIALS_FILE: credentials,
      AWS_MAX_ATTEMPTS: '7',
      AWS_RETRY_MODE: 'legacy',
      AWS_ACCESS_KEY_ID: 'POISONED-AMBIENT-KEY',
      AWS_SECRET_ACCESS_KEY: 'POISONED-AMBIENT-SECRET',
    });
    // Poison again after selection: the subprocess itself must enforce the rule.
    operator.environment.AWS_MAX_ATTEMPTS = '8';
    operator.environment.AWS_RETRY_MODE = 'adaptive';
    let error: unknown;
    let output: string | undefined;
    try {
      output = await runAWSCLI(operator, [
        'iam',
        command,
        '--user-name',
        'anycloud-loopback',
        '--endpoint-url',
        `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      ]);
    } catch (caught) {
      error = caught;
    }
    return { requests, error, output };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}

const exec = promisify(execFile);

async function listenLoopback(server: Server): Promise<string> {
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function rejectingProxy() {
  const attempts = { http: 0, connect: 0 };
  const server = createServer((request, response) => {
    attempts.http += 1;
    request.resume();
    response.writeHead(502, { connection: 'close' });
    response.end();
  });
  // HTTPS proxy attempts use CONNECT and never reach the HTTP request handler.
  server.on('connect', (_request, socket) => {
    attempts.connect += 1;
    socket.end(
      'HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
      () => socket.destroy(),
    );
  });
  return { server, attempts };
}

async function requireLoginCLI(operator: AWSOperator): Promise<void> {
  const requirement =
    'AWS login-cache regressions require AWS CLI v2 >=2.32.0 on PATH.';
  let stdout: string;
  try {
    ({ stdout } = await exec('aws', ['--version'], {
      env: operator.environment,
      timeout: 15_000,
      encoding: 'utf8',
    }));
  } catch (cause) {
    throw new Error(requirement, { cause });
  }
  const version = stdout.trim().match(/^aws-cli\/(\d+)\.(\d+)\.(\d+)(?:\s|$)/);
  if (!version || Number(version[1]) !== 2 || Number(version[2]) < 32) {
    throw new Error(
      `${requirement} Found: ${stdout.trim() || '(empty version)'}`,
    );
  }
}

/** Synthetic login cache and real CLI signing; no browser login or AWS refresh. */
export async function probeAWSLoginCache(
  mode: 'valid' | 'missing-directory' | 'omitted-override' | 'static-shadow',
) {
  const root = await mkdtemp(join(tmpdir(), 'anycloud-aws-login-'));
  const requests: {
    action: string | null;
    accessKeyId: string | undefined;
    sessionToken: string | string[] | undefined;
  }[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      requests.push({
        action: new URLSearchParams(body).get('Action'),
        accessKeyId:
          request.headers.authorization?.match(/Credential=([^/]+)\//)?.[1],
        sessionToken: request.headers['x-amz-security-token'],
      });
      response.writeHead(200, { 'content-type': 'text/xml' });
      response.end(
        '<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Arn>arn:aws:iam::123456789012:user/login-cache-test</Arn><UserId>AIDASYNTHETICUSER</UserId><Account>123456789012</Account></GetCallerIdentityResult><ResponseMetadata><RequestId>loopback</RequestId></ResponseMetadata></GetCallerIdentityResponse>',
      );
    });
  });
  const proxy = rejectingProxy();
  try {
    const isolatedHome = join(root, 'home');
    const cache = join(root, 'original-login-cache');
    const config = join(root, 'config');
    const credentials = join(root, 'credentials');
    const loginSession = 'arn:aws:iam::123456789012:user/login-cache-test';
    await mkdir(isolatedHome, { mode: 0o700 });
    await mkdir(cache, { mode: 0o700 });
    await writeFile(
      config,
      `[profile operator]\nregion = us-east-1\nlogin_session = ${loginSession}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      credentials,
      mode === 'static-shadow'
        ? '[operator]\naws_access_key_id = AKIASTATICCACHE00000\naws_secret_access_key = synthetic-static-secret\n'
        : '',
      { mode: 0o600 },
    );
    const { privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    // AWS CLI hashes login_session to locate this cache; keep it outside HOME.
    const cacheKey = createHash('sha256').update(loginSession).digest('hex');
    await writeFile(
      join(cache, `${cacheKey}.json`),
      JSON.stringify({
        accessToken: {
          accessKeyId: 'ASIALOGINCACHE0000000',
          secretAccessKey: 'synthetic-login-secret',
          sessionToken: 'synthetic-login-session-token',
          accountId: '123456789012',
          expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        },
        refreshToken: 'synthetic-refresh-token-not-valid-with-aws',
        dpopKey: privateKey,
        clientId:
          'arn:aws:signin:us-east-1:123456789012:oauth2/public-client/localhost',
      }),
      { mode: 0o600 },
    );
    const endpoint = await listenLoopback(server);
    const proxyEndpoint = await listenLoopback(proxy.server);
    const operator = awsOperator('operator', {
      // Freeze PATH for both preflight and the production runner. Do not inherit
      // real profiles, credentials, or proxy bypasses from the test process.
      PATH: process.env.PATH,
      HOME: isolatedHome,
      AWS_CONFIG_FILE: config,
      AWS_SHARED_CREDENTIALS_FILE: credentials,
      ...(mode === 'omitted-override'
        ? {}
        : {
            AWS_LOGIN_CACHE_DIRECTORY:
              mode === 'missing-directory'
                ? join(root, 'missing-cache')
                : cache,
          }),
      AWS_ACCESS_KEY_ID: 'POISONED-AMBIENT-KEY',
      AWS_SECRET_ACCESS_KEY: 'POISONED-AMBIENT-SECRET',
      AWS_SESSION_TOKEN: 'POISONED-AMBIENT-TOKEN',
      HTTP_PROXY: proxyEndpoint,
      HTTPS_PROXY: proxyEndpoint,
      NO_PROXY: '127.0.0.1,localhost',
    });
    // Unsupported/missing binaries must fail fixture setup, never satisfy a
    // missing-cache assertion by returning an unrelated command failure.
    await requireLoginCLI(operator);
    let credentialSource: string | undefined;
    if (mode === 'valid' || mode === 'static-shadow') {
      const { stdout } = await exec(
        'aws',
        ['configure', 'list', '--profile', operator.profile],
        {
          env: operator.environment,
          timeout: 15_000,
          encoding: 'utf8',
        },
      );
      credentialSource = stdout
        .split('\n')
        .find((line) => line.trim().startsWith('access_key'))
        ?.split(':')[2]
        ?.trim();
    }
    let error: unknown;
    try {
      await runAWSCLI(operator, [
        'sts',
        'get-caller-identity',
        '--endpoint-url',
        endpoint,
      ]);
    } catch (caught) {
      error = caught;
    }
    return {
      credentialSource,
      requests,
      unexpectedRequests: proxy.attempts,
      error,
    };
  } finally {
    await closeServer(server);
    await closeServer(proxy.server);
    await rm(root, { recursive: true, force: true });
  }
}

export async function probeAWSRejectingProxy() {
  const proxy = rejectingProxy();
  try {
    const endpoint = await listenLoopback(proxy.server);
    const statuses: (number | undefined)[] = [];
    for (const [method, path] of [
      ['GET', 'http://signin.example.invalid/'],
      ['CONNECT', 'signin.example.invalid:443'],
    ]) {
      statuses.push(
        await new Promise<number | undefined>((resolve, reject) => {
          const request = httpRequest(endpoint, { method, path, agent: false });
          request.on('response', (response) => {
            response.resume();
            response.on('end', () => resolve(response.statusCode));
          });
          request.on('connect', (response, socket) => {
            socket.destroy();
            resolve(response.statusCode);
          });
          request.on('error', reject);
          request.setTimeout(5_000, () =>
            request.destroy(new Error('Loopback proxy control timed out.')),
          );
          request.end();
        }),
      );
    }
    return { statuses, attempts: proxy.attempts };
  } finally {
    await closeServer(proxy.server);
  }
}
