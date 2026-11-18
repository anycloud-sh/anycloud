import { randomUUID } from 'node:crypto';
import { link, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

export const LOCAL_KUBERNETES_PROTOCOL_VERSION = 1 as const;

const absolutePath = z
  .string()
  .min(1)
  .refine((value) => path.isAbsolute(value), {
    message: 'path must be absolute',
  });
const port = z.number().int().min(1).max(65_535);
const identity = z.string().min(1).max(200);

export const localKubernetesChildConfigSchema = z
  .object({
    version: z.literal(LOCAL_KUBERNETES_PROTOCOL_VERSION),
    apiPort: port,
    cipherKey: z.string().length(64),
    launchNonce: identity,
    projectRoot: absolutePath,
    readyPath: absolutePath,
    runId: z.string().regex(/^[a-z0-9]{6,32}$/u),
    stateRoot: absolutePath,
    workloadApiUrl: z.string().url(),
    /** The cluster record the child API writes before serving (installer kind). */
    cluster: z
      .object({
        name: identity,
        kubernetesIdentity: identity,
        connection: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export type LocalKubernetesChildConfig = z.output<
  typeof localKubernetesChildConfigSchema
>;

export const localKubernetesReadyRecordSchema = z
  .object({
    version: z.literal(LOCAL_KUBERNETES_PROTOCOL_VERSION),
    launchNonce: identity,
    pid: z.number().int().positive(),
    port,
  })
  .strict();

export type LocalKubernetesReadyRecord = z.output<
  typeof localKubernetesReadyRecordSchema
>;

export function parseLocalKubernetesReadyRecord(
  value: unknown,
  expected: {
    readonly launchNonce: string;
    readonly pid: number;
    readonly port: number;
  },
): LocalKubernetesReadyRecord {
  const record = localKubernetesReadyRecordSchema.parse(value);
  if (record.launchNonce !== expected.launchNonce) {
    throw new Error('Local Kubernetes child emitted a stale launch nonce');
  }
  if (record.pid !== expected.pid) {
    throw new Error(
      'Local Kubernetes child ready PID does not match its process',
    );
  }
  if (record.port !== expected.port) {
    throw new Error('Local Kubernetes child bound an unexpected API port');
  }
  return record;
}

export async function writeLocalKubernetesReadyRecord(
  readyPath: string,
  record: LocalKubernetesReadyRecord,
): Promise<void> {
  const canonical = localKubernetesReadyRecordSchema.parse(record);
  const temporaryPath = `${readyPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(canonical)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    // Hard-linking a complete same-directory file makes readiness visible in
    // one atomic operation and still fails closed if any writer already owns
    // the final path. A direct write lets the parent observe partial JSON.
    await link(temporaryPath, readyPath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}
