import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { prepareGCPServiceAccountKeyImport } from '../../../../../src/cli/services/slurp/gcp.js';

const KEY = {
  type: 'service_account',
  project_id: 'reviewed-project',
  private_key_id: 'reviewed-key-id',
  private_key:
    '-----BEGIN PRIVATE KEY-----\nREVIEWED-KEY\n-----END PRIVATE KEY-----',
  client_email: 'reviewed@reviewed-project.iam.gserviceaccount.com',
};

describe('prepared GCP key imports', () => {
  let root: string;
  let source: string;
  let anycloudDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'anycloud-key-import-'));
    source = join(root, 'uploaded-key.json');
    anycloudDir = join(root, 'anycloud');
    vi.stubEnv('ANYCLOUD_DIR', anycloudDir);
    await writeFile(source, JSON.stringify(KEY), { mode: 0o600 });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it('leaves no copy before approval and persists the reviewed contents even if the source changes', async () => {
    const prepared = await prepareGCPServiceAccountKeyImport(source);
    expect(prepared).toMatchObject({
      projectId: KEY.project_id,
      clientEmail: KEY.client_email,
      privateKey: KEY.private_key,
      keyFilePath: join(anycloudDir, 'anycloud-uploaded-key.json'),
    });
    await expect(access(anycloudDir)).rejects.toMatchObject({ code: 'ENOENT' });

    await writeFile(
      source,
      JSON.stringify({
        ...KEY,
        project_id: 'changed-project',
        private_key: 'CHANGED-KEY',
      }),
    );
    await prepared.persist();

    expect(JSON.parse(await readFile(prepared.keyFilePath, 'utf8'))).toEqual(
      KEY,
    );
    expect((await stat(prepared.keyFilePath)).mode & 0o777).toBe(0o600);
  });

  it.each([
    ['malformed JSON', '{"type":"service_account",'],
    [
      'user ADC',
      JSON.stringify({ type: 'authorized_user', refresh_token: 'temporary' }),
    ],
    ['missing private key', JSON.stringify({ ...KEY, private_key: undefined })],
  ])('rejects %s without creating a destination', async (_label, contents) => {
    await writeFile(source, contents);
    await expect(prepareGCPServiceAccountKeyImport(source)).rejects.toThrow(
      'Invalid service account key file',
    );
    await expect(access(anycloudDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
