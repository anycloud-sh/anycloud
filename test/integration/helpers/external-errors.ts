import { inspect } from 'node:util';
import { ClientSecretCredential } from '@azure/identity';

export async function requireAzureAuthentication(auth: {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}): Promise<void> {
  const credential = new ClientSecretCredential(
    auth.tenantId,
    auth.clientId,
    auth.clientSecret,
  );
  await credential.getToken('https://management.azure.com/.default');
}

function stringifyErrorPart(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  return inspect(value);
}

export function errorText(error: unknown): string {
  const parts: string[] = [];
  if (error instanceof Error) {
    parts.push(error.name, error.message);
    if (error.stack) parts.push(error.stack);
  }

  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const keys = [
      ...(error instanceof Error ? [] : ['name', 'message']),
      'Code',
      'code',
      'errorCode',
      'stdout',
      'stderr',
    ];
    for (const key of keys) {
      const text = stringifyErrorPart(record[key]);
      if (text) parts.push(text);
    }
  }

  if (parts.length === 0) {
    parts.push(stringifyErrorPart(error) ?? 'Unknown error');
  }
  return parts.filter(Boolean).join('\n');
}
