import { runGcloud, type GCPOperator } from './gcp-cli-runner.js';

type GCPService = 'iam' | 'projects';
const ORIGINS = {
  iam: 'https://iam.googleapis.com',
  projects: 'https://cloudresourcemanager.googleapis.com',
} as const;

export class GCPBootstrapError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
    readonly missingServiceAccount?: string,
  ) {
    super(message);
    this.name = 'GCPBootstrapError';
  }
}

export interface GCPTransport {
  request(
    service: GCPService,
    path: string,
    method?: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    body?: unknown,
  ): Promise<unknown>;
}

async function readBoundedResponse(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1024 * 1024) {
        await reader.cancel();
        throw new Error('Response exceeds the GCP generation output limit.');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Keep the operator token local and dispatch each IAM write exactly once. */
export async function createGCPTransport(
  operator: GCPOperator,
): Promise<GCPTransport> {
  const token = (
    await runGcloud(
      [
        'auth',
        'print-access-token',
        `--account=${operator.account}`,
        `--project=${operator.projectId}`,
      ],
      operator.environment,
    )
  ).trim();
  if (!token || /\s/.test(token)) {
    throw new GCPBootstrapError('gcloud returned an invalid access token.');
  }
  return gcpTransport(token);
}

/** Dispatch each IAM write exactly once with an access token. */
export function gcpTransport(token: string): GCPTransport {
  return {
    async request(service, path, method = 'GET', body) {
      if (!path.startsWith('/v1/projects/') || path.includes('://')) {
        throw new GCPBootstrapError('Invalid GCP generation resource path.');
      }
      let response: Response;
      let output: string;
      try {
        response = await fetch(`${ORIGINS[service]}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(30_000),
          redirect: 'error',
        });
        output = await readBoundedResponse(response);
      } catch {
        // A lost response cannot establish whether an IAM mutation committed.
        throw new GCPBootstrapError(
          'GCP request failed or timed out; it may have succeeded.',
        );
      }
      if (!response.ok) {
        // API diagnostics may echo request or credential material. Retain only status.
        let code: string | undefined;
        let missingServiceAccount: string | undefined;
        try {
          const payload = JSON.parse(output) as {
            error?: {
              status?: string;
              message?: string;
              details?: Array<{ reason?: unknown }>;
            };
          };
          if (
            [
              'INVALID_ARGUMENT',
              'PERMISSION_DENIED',
              'UNAUTHENTICATED',
              'NOT_FOUND',
              'ALREADY_EXISTS',
              'ABORTED',
              'RESOURCE_EXHAUSTED',
              'UNAVAILABLE',
            ].includes(payload.error?.status ?? '')
          )
            code = payload.error!.status;
          // A disabled API is reported as PERMISSION_DENIED but needs no grant.
          if (
            code === 'PERMISSION_DENIED' &&
            payload.error?.details?.some(
              (detail) => detail.reason === 'SERVICE_DISABLED',
            )
          )
            code = 'SERVICE_DISABLED';
          if (
            response.status === 400 &&
            code === 'INVALID_ARGUMENT' &&
            typeof payload.error?.message === 'string'
          ) {
            missingServiceAccount = payload.error.message.match(
              /^(?:Exception calling IAM: )?Service account ([a-z0-9-]+@[a-z0-9.-]+) does not exist\.$/,
            )?.[1];
          }
        } catch {
          /* Unrecognized diagnostics stay redacted. */
        }
        throw new GCPBootstrapError(
          `GCP request failed (HTTP ${response.status}${code ? `, ${code}` : ''}). Check the selected operator, project, enabled APIs, and permissions.`,
          response.status,
          code,
          missingServiceAccount,
        );
      }
      if (!output.trim()) return {};
      try {
        return JSON.parse(output) as unknown;
      } catch {
        throw new GCPBootstrapError(
          'GCP returned invalid output; the request may have succeeded.',
        );
      }
    },
  };
}
