import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { resolve } from 'path';

/**
 * GCP Service Account Key JSON structure
 */
export interface GCPServiceAccountKey {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
  auth_uri: string;
  token_uri: string;
  auth_provider_x509_cert_url: string;
  client_x509_cert_url: string;
}

/**
 * GCP Credentials for workload
 */
export interface GCPCredsCLI {
  projectId: string;
  privateKey: string;
  clientEmail: string;
}

export interface GCPServiceAccountKeySummary {
  projectId: string;
  clientEmail: string;
}

export function resolveServiceAccountKeyPath(filePath: string): string {
  if (filePath === '~') return homedir();
  if (filePath.startsWith('~/') || filePath.startsWith('~\\')) {
    return resolve(homedir(), filePath.slice(2));
  }
  return resolve(filePath);
}

function describeKeyReadError(error: unknown): string {
  if (error instanceof SyntaxError) return 'invalid JSON';
  if (error instanceof Error) return error.message;
  return 'unknown error';
}

async function readServiceAccountKeyWithRequiredFields(
  keyPath: string,
  requiredFields: readonly string[],
  transformContent: (content: string) => string = (content) => content,
): Promise<GCPServiceAccountKey> {
  try {
    const content = await readFile(
      resolveServiceAccountKeyPath(keyPath),
      'utf-8',
    );
    const parsed: unknown = JSON.parse(transformContent(content));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error('Invalid service account key: expected a JSON object');
    }
    const key = parsed as Record<string, unknown>;

    // Validate it's a service account key
    if (key.type !== 'service_account') {
      throw new Error(
        `Invalid service account key: type is "${key.type}", expected "service_account"`,
      );
    }

    for (const field of requiredFields) {
      const value = key[field];
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(
          `Invalid service account key: missing required field: ${field}`,
        );
      }
    }

    return key as unknown as GCPServiceAccountKey;
  } catch (error) {
    throw new Error(
      `Failed to read GCP service account key from ${keyPath}: ${describeKeyReadError(error)}`,
    );
  }
}

function redactGCPPrivateKey(content: string): string {
  return content.replace(
    /("private_key"\s*:\s*)"(?:\\[\s\S]|[^"\\])*"/g,
    `$1"<redacted>"`,
  );
}

/**
 * Read a deployable service account key JSON file.
 */
export async function readServiceAccountKey(
  keyPath: string,
): Promise<GCPServiceAccountKey> {
  return readServiceAccountKeyWithRequiredFields(keyPath, [
    'project_id',
    'client_email',
    'private_key',
  ]);
}

/** Read only non-secret identity metadata from a service-account key file. */
export async function readServiceAccountKeySummary(
  keyPath: string,
): Promise<GCPServiceAccountKeySummary> {
  const key = await readServiceAccountKeyWithRequiredFields(
    keyPath,
    ['project_id', 'client_email', 'private_key'],
    redactGCPPrivateKey,
  );
  return { projectId: key.project_id, clientEmail: key.client_email };
}

/**
 * Extract workload credentials from service account key
 */
export function extractGCPCredentials(key: GCPServiceAccountKey): GCPCredsCLI {
  return {
    projectId: key.project_id,
    privateKey: key.private_key,
    clientEmail: key.client_email,
  };
}
