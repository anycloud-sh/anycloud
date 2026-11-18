import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CloudType } from '../../../../src/shared/cloud.js';
import { ArtifactStore, Redactor } from '../../e2e/internal/artifacts.js';
import { FixtureFiles } from '../../e2e/internal/files.js';
import { ProcessRunner } from '../../e2e/internal/process.js';
import { inspectAzureJobIdentity } from './identity-readback.js';

async function main(): Promise<void> {
  const runId = Number(process.env.GITHUB_RUN_ID);
  const attempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  const outputDirectory = `/tmp/azure-job-identity-readback/${runId}-${attempt}`;
  // A failed invocation must never upload another attempt's or a stale receipt.
  await rm(outputDirectory, { recursive: true, force: true });
  const root = await mkdtemp(path.join(tmpdir(), 'azure-job-readback-'));
  const redactor = new Redactor();
  const artifacts = new ArtifactStore(outputDirectory, redactor);
  const signal = new AbortController().signal;
  let request: unknown;
  try {
    request = JSON.parse(
      process.env.E2E_AZURE_JOB_IDENTITY_READBACK ?? 'null',
    ) as unknown;
  } catch {
    request = undefined;
  }
  try {
    const receipt = await inspectAzureJobIdentity(
      request,
      {
        cloudProvider: CloudType.Azure,
        applicationId:
          process.env.AZURE_CLIENT_ID ?? process.env.AZURE_APPLICATION_ID,
        secret: process.env.AZURE_CLIENT_SECRET ?? process.env.AZURE_SECRET,
        directoryId:
          process.env.AZURE_TENANT_ID ?? process.env.AZURE_DIRECTORY_ID,
        subscriptionId: process.env.AZURE_SUBSCRIPTION_ID,
      },
      {
        source: process.env.GITHUB_SHA,
        runId,
        attempt,
      },
      {
        runner: new ProcessRunner(artifacts, signal, process.cwd()),
        files: new FixtureFiles(root),
        redactor,
        signal,
        originalRun:
          process.env.ORIGINAL_RUN_ID !== undefined ||
          process.env.ORIGINAL_RUN_ATTEMPT !== undefined
            ? {
                runId: Number(process.env.ORIGINAL_RUN_ID),
                attempt: Number(process.env.ORIGINAL_RUN_ATTEMPT),
              }
            : undefined,
      },
    );
    await artifacts.json('receipt', receipt);
    if (!receipt.complete || !receipt.absent) process.exitCode = 1;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch(() => {
  console.error(
    'Azure Job identity readback failed before retaining its receipt.',
  );
  process.exitCode = 1;
});
