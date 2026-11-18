import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from 'vitest';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { ORPCError } from '@orpc/client';

const api = vi.hoisted(() => ({
  uploadBucketObject: vi.fn(),
  downloadBucketObject: vi.fn(),
  bucketExists: vi.fn(),
  createBucket: vi.fn(),
  deleteBucket: vi.fn(),
  deleteBucketObject: vi.fn(),
  listBucketObjects: vi.fn(),
  listBuckets: vi.fn(),
  listApiCredentials: vi.fn(),
  getAnycloudVersion: vi.fn(() => '0.0.0-test'),
}));

vi.mock('../../../src/cli/utils/output.js', async (importActual) => {
  const actual =
    await importActual<typeof import('../../../src/cli/utils/output.js')>();
  return {
    ...actual,
    createSpinner: () => ({ start: () => ({ stop: () => undefined }) }),
    printInfo: vi.fn(),
    printError: vi.fn(),
    printSuccess: vi.fn(),
    printWarning: vi.fn(),
  };
});

vi.mock(
  '../../../src/shared/services/api-client/native.js',
  async (importActual) => ({
    ApiHttpError: (
      await importActual<
        typeof import('../../../src/shared/services/api-client/native.js')
      >()
    ).ApiHttpError,
    uploadBucketObject: api.uploadBucketObject,
    downloadBucketObject: api.downloadBucketObject,
  }),
);

vi.mock('../../../src/shared/services/api-client/runtime.js', () => ({
  getAnycloudVersion: api.getAnycloudVersion,
}));

vi.mock('../../../src/shared/services/api-client/rpc.js', () => ({
  createApiClient: (accessToken: string) => ({
    credentials: {
      list: () => api.listApiCredentials(accessToken),
    },
    bucket: {
      exists: ({ params, query }: DetailedBucketInput) =>
        api.bucketExists(accessToken, { ...params, ...query }),
      create: ({ params, query }: DetailedBucketInput) =>
        api.createBucket(accessToken, { ...params, ...query }),
      delete: ({ params, query }: DetailedBucketInput) =>
        api.deleteBucket(accessToken, { ...params, ...query }),
      deleteObject: ({ params, query }: DetailedBucketInput) =>
        api.deleteBucketObject(accessToken, { ...params, ...query }),
      list: ({ params, query }: DetailedBucketInput) =>
        api.listBuckets(accessToken, {
          ...params,
          ...query,
          ...(query.pageSize ? { pageSize: Number(query.pageSize) } : {}),
        }),
      objects: ({ params, query }: DetailedBucketInput) =>
        api.listBucketObjects(accessToken, {
          ...params,
          ...query,
          ...(query.pageSize ? { pageSize: Number(query.pageSize) } : {}),
          ...(query.recursive ? { recursive: query.recursive === 'true' } : {}),
        }),
    },
  }),
}));

interface DetailedBucketInput {
  params: Record<string, string>;
  query: Record<string, string | undefined>;
}

vi.mock('../../../src/cli/services/auth.js', async () =>
  (await import('./cli-auth-mock.js')).cliAuthMock(),
);

vi.mock('../../../src/cli/utils/safe-prompts.js', () => ({
  shouldAllowPrompts: vi.fn(() => false),
  safePrompts: vi.fn(),
}));

import { createBucketCommand } from '../../../src/cli/commands/bucket/index.js';
import { CloudType } from '../../../src/shared/cloud.js';
import { ApiHttpError } from '../../../src/shared/services/api-client/native.js';
import {
  printError,
  printInfo,
  printSuccess,
  printWarning,
  setJsonMode,
} from '../../../src/cli/utils/output.js';
import {
  safePrompts,
  shouldAllowPrompts,
} from '../../../src/cli/utils/safe-prompts.js';

const uploadBucketObject = api.uploadBucketObject;
const downloadBucketObject = api.downloadBucketObject;
const bucketExists = api.bucketExists;
const deleteBucketObject = api.deleteBucketObject;
const listBucketObjects = api.listBucketObjects;
const listBuckets = api.listBuckets;
const listApiCredentials = api.listApiCredentials;

beforeEach(() => {
  setJsonMode(false);
  vi.mocked(listApiCredentials).mockResolvedValue([
    { name: 'prod-aws', cloudProvider: CloudType.AWS },
    { name: 'prod-gcp', cloudProvider: CloudType.GCP },
  ]);
});

describe('createBucketCommand upload', () => {
  let exitSpy: MockInstance<typeof process.exit>;
  let workDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(shouldAllowPrompts).mockReturnValue(false);
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit:${code ?? 0}`);
      });
    workDir = mkdtempSync(join(tmpdir(), 'bucket-test-'));
  });

  afterEach(() => {
    exitSpy.mockRestore();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('streams the local file and forwards bucket/remote/credentials', async () => {
    const local = join(workDir, 'in.bin');
    writeFileSync(local, Buffer.from('hello-bytes'));
    vi.mocked(uploadBucketObject).mockImplementation(async (_token, body) => {
      for await (const _ of body as AsyncIterable<unknown>) {
        // drain so the underlying file handle is released
      }
    });

    await createBucketCommand().parseAsync([
      'node',
      'test',
      'upload',
      'my-bucket',
      local,
      'remote/key',
      '--credentials',
      'prod-aws',
      '--region',
      'us-east-1',
    ]);

    expect(uploadBucketObject).toHaveBeenCalledTimes(1);
    const [token, , size, params] = vi.mocked(uploadBucketObject).mock.calls[0];
    expect(token).toBe('test-token');
    expect(size).toBe('hello-bytes'.length);
    expect(params).toEqual({
      bucketName: 'my-bucket',
      remotePath: 'remote/key',
      credentialName: 'prod-aws',
      region: 'us-east-1',
    });
  });

  it('auto-selects the only saved credential when --credentials is omitted', async () => {
    vi.mocked(listApiCredentials).mockResolvedValueOnce([
      { name: 'solo-aws', cloudProvider: CloudType.AWS },
    ]);
    const local = join(workDir, 'in.bin');
    writeFileSync(local, Buffer.from('hello-bytes'));
    vi.mocked(uploadBucketObject).mockImplementation(async (_token, body) => {
      for await (const _ of body as AsyncIterable<unknown>) {
        // drain so the underlying file handle is released
      }
    });

    await createBucketCommand().parseAsync([
      'node',
      'test',
      'upload',
      'my-bucket',
      local,
      'remote/key',
    ]);

    expect(uploadBucketObject).toHaveBeenCalledTimes(1);
    const [, , , params] = vi.mocked(uploadBucketObject).mock.calls[0];
    expect(params).toMatchObject({ credentialName: 'solo-aws' });
  });

  it('streams every stdin byte without declaring an empty Content-Length', async () => {
    const payload = Buffer.from('complete backup\0\u00e9\u2603');
    const input = Readable.from([payload.subarray(0, 5), payload.subarray(5)]);
    const stdin = vi
      .spyOn(process, 'stdin', 'get')
      .mockReturnValue(input as typeof process.stdin);
    const received: Buffer[] = [];
    vi.mocked(uploadBucketObject).mockImplementation(async (_token, body) => {
      for await (const chunk of body as AsyncIterable<Buffer>)
        received.push(chunk);
    });
    try {
      await createBucketCommand().parseAsync([
        'node',
        'test',
        'upload',
        'migration-backup',
        '-',
        'initial.tar.gz',
        '--credentials',
        'prod-aws',
        '--region',
        'us-east-1',
      ]);
      expect(Buffer.concat(received)).toEqual(payload);
      expect(uploadBucketObject).toHaveBeenCalledOnce();
      expect(uploadBucketObject.mock.calls[0]?.[2]).toBeUndefined();
      expect(uploadBucketObject.mock.calls[0]?.[3]).toEqual({
        bucketName: 'migration-backup',
        remotePath: 'initial.tar.gz',
        credentialName: 'prod-aws',
        region: 'us-east-1',
      });
      expect(printSuccess).toHaveBeenCalledWith(
        'Uploaded stdin to migration-backup/initial.tar.gz',
      );
    } finally {
      stdin.mockRestore();
    }
  });

  it('reports a broken stdin stream as a failed upload', async () => {
    const input = Readable.from(
      (async function* () {
        yield Buffer.from('partial backup');
        throw new Error('Source stream failed');
      })(),
    );
    const stdin = vi
      .spyOn(process, 'stdin', 'get')
      .mockReturnValue(input as typeof process.stdin);
    vi.mocked(uploadBucketObject).mockImplementation(async (_token, body) => {
      for await (const _ of body as AsyncIterable<Buffer>) {
        // Consume the stream through the transfer boundary.
      }
    });
    try {
      await expect(
        createBucketCommand().parseAsync([
          'node',
          'test',
          'upload',
          'migration-backup',
          '-',
          'initial.tar.gz',
          '--credentials',
          'prod-aws',
        ]),
      ).rejects.toThrow('process.exit:1');
      expect(printError).toHaveBeenCalledWith(
        'Upload failed: Source stream failed',
      );
      expect(printSuccess).not.toHaveBeenCalled();
    } finally {
      stdin.mockRestore();
    }
  });

  it('rejects recursive stdin before starting a transfer', async () => {
    await expect(
      createBucketCommand().parseAsync([
        'node',
        'test',
        'upload',
        'migration-backup',
        '-',
        'initial.tar.gz',
        '--recursive',
        '--credentials',
        'prod-aws',
      ]),
    ).rejects.toThrow('process.exit:1');
    expect(printError).toHaveBeenCalledWith(
      'Upload failed: Stdin uploads cannot use --recursive',
    );
    expect(uploadBucketObject).not.toHaveBeenCalled();
  });

  it('upload exits non-zero when the API call fails', async () => {
    const local = join(workDir, 'in.bin');
    writeFileSync(local, 'x');
    vi.mocked(uploadBucketObject).mockImplementation(async (_token, body) => {
      for await (const _ of body as AsyncIterable<unknown>) {
        // drain
      }
      throw new Error('forbidden');
    });

    await expect(
      createBucketCommand().parseAsync([
        'node',
        'test',
        'upload',
        'my-bucket',
        local,
        'remote/key',
        '--credentials',
        'prod-aws',
      ]),
    ).rejects.toThrow(/process\.exit:1/);
  });

  it('uploads a complete sorted directory manifest beneath a prefix', async () => {
    const source = join(workDir, 'source');
    mkdirSync(join(source, 'nested'), { recursive: true });
    writeFileSync(join(source, '.hidden'), 'h');
    writeFileSync(join(source, 'z.txt'), 'zz');
    writeFileSync(join(source, 'nested', 'a.txt'), 'aaa');
    vi.mocked(uploadBucketObject).mockImplementation(async (_token, body) => {
      for await (const _ of body as AsyncIterable<unknown>) {
        // Drain every concurrent file stream.
      }
    });

    await createBucketCommand().parseAsync([
      'node',
      'test',
      'upload',
      'my-bucket',
      source,
      'models/',
      '--recursive',
      '--concurrency',
      '2',
      '--credentials',
      'prod-aws',
    ]);

    const keys = vi
      .mocked(uploadBucketObject)
      .mock.calls.map((call) => call[3]?.remotePath)
      .sort();
    expect(keys).toEqual([
      'models/.hidden',
      'models/nested/a.txt',
      'models/z.txt',
    ]);
  });

  it('uploads directory contents directly to the bucket root', async () => {
    const source = join(workDir, 'source');
    mkdirSync(join(source, 'nested'), { recursive: true });
    writeFileSync(join(source, 'root.txt'), 'root');
    writeFileSync(join(source, 'nested', 'value.txt'), 'nested');
    vi.mocked(uploadBucketObject).mockImplementation(async (_token, body) => {
      for await (const _ of body as AsyncIterable<unknown>) {
        // Drain every file stream.
      }
    });

    await createBucketCommand().parseAsync([
      'node',
      'test',
      'upload',
      'my-bucket',
      source,
      '',
      '--recursive',
      '--credentials',
      'prod-aws',
    ]);

    expect(
      vi
        .mocked(uploadBucketObject)
        .mock.calls.map((call) => call[3]?.remotePath),
    ).toEqual(['nested/value.txt', 'root.txt']);
  });

  it('attempts every recursive upload and reports failures in manifest order', async () => {
    const source = join(workDir, 'source');
    mkdirSync(source);
    writeFileSync(join(source, 'a'), 'a');
    writeFileSync(join(source, 'b'), 'b');
    writeFileSync(join(source, 'c'), 'c');
    vi.mocked(uploadBucketObject).mockImplementation(
      async (_token, body, _size, params) => {
        for await (const _ of body as AsyncIterable<unknown>) {
          // Drain every file stream before simulating the response.
        }
        if (params?.remotePath !== 'p/b') {
          throw new Error(`denied ${params?.remotePath}`);
        }
      },
    );

    await expect(
      createBucketCommand().parseAsync([
        'node',
        'test',
        'upload',
        'my-bucket',
        source,
        'p/',
        '--recursive',
        '--concurrency',
        '2',
        '--credentials',
        'prod-aws',
      ]),
    ).rejects.toThrow(/process\.exit:1/);

    expect(uploadBucketObject).toHaveBeenCalledTimes(3);
    expect(
      vi.mocked(printError).mock.calls.map(([message]) => message),
    ).toEqual([
      'Recursive upload partially failed: 1/3 object(s), 1 B',
      'p/a: denied p/a',
      'p/c: denied p/c',
    ]);
  });

  it('succeeds without requests for an empty recursive upload', async () => {
    const source = join(workDir, 'source');
    mkdirSync(source);

    await createBucketCommand().parseAsync([
      'node',
      'test',
      'upload',
      'my-bucket',
      source,
      'empty/',
      '--recursive',
      '--credentials',
      'prod-aws',
    ]);

    expect(uploadBucketObject).not.toHaveBeenCalled();
    expect(printSuccess).toHaveBeenCalledWith(
      'Uploaded 0/0 object(s), 0 B to my-bucket/empty/',
    );
  });

  it('rejects recursive-only upload options and unsafe prefixes', async () => {
    const source = join(workDir, 'source');
    mkdirSync(source);
    writeFileSync(join(source, 'file'), 'x');

    await expect(
      createBucketCommand().parseAsync([
        'node',
        'test',
        'upload',
        'my-bucket',
        source,
        'models',
        '--recursive',
        '--credentials',
        'prod-aws',
      ]),
    ).rejects.toThrow(/process\.exit:1/);
    await expect(
      createBucketCommand().parseAsync([
        'node',
        'test',
        'upload',
        'my-bucket',
        join(source, 'file'),
        'file',
        '--concurrency',
        '2',
        '--credentials',
        'prod-aws',
      ]),
    ).rejects.toThrow(/process\.exit:1/);
    expect(uploadBucketObject).not.toHaveBeenCalled();
  });

  it('rejects a file source and unsupported credentials before recursive upload', async () => {
    const source = join(workDir, 'source');
    mkdirSync(source);
    const file = join(source, 'file');
    writeFileSync(file, 'x');

    await expect(
      createBucketCommand().parseAsync([
        'node',
        'test',
        'upload',
        'my-bucket',
        file,
        'p/',
        '--recursive',
        '--credentials',
        'prod-aws',
      ]),
    ).rejects.toThrow(/process\.exit:1/);

    vi.mocked(listApiCredentials).mockResolvedValueOnce([
      { name: 'local', cloudProvider: CloudType.Local },
    ]);
    await expect(
      createBucketCommand().parseAsync([
        'node',
        'test',
        'upload',
        'my-bucket',
        source,
        'p/',
        '--recursive',
        '--credentials',
        'local',
      ]),
    ).rejects.toThrow(/process\.exit:1/);

    expect(uploadBucketObject).not.toHaveBeenCalled();
  });

  it('requires an explicit saved credential before recursive upload starts', async () => {
    const source = join(workDir, 'source');
    mkdirSync(source);
    writeFileSync(join(source, 'file'), 'x');

    await expect(
      createBucketCommand().parseAsync([
        'node',
        'test',
        'upload',
        'my-bucket',
        source,
        'p/',
        '--recursive',
      ]),
    ).rejects.toThrow(/process\.exit:1/);

    expect(uploadBucketObject).not.toHaveBeenCalled();
  });
});

describe('createBucketCommand download', () => {
  let exitSpy: MockInstance<typeof process.exit>;
  let workDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit:${code ?? 0}`);
      });
    workDir = mkdtempSync(join(tmpdir(), 'bucket-test-'));
  });

  afterEach(() => {
    exitSpy.mockRestore();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('writes the response stream to the destination path', async () => {
    const payload = Buffer.from('payload-bytes');
    vi.mocked(downloadBucketObject).mockResolvedValue({
      stream: Readable.from([payload]),
      contentLength: payload.length,
    });
    const dest = join(workDir, 'out.bin');

    await createBucketCommand().parseAsync([
      'node',
      'test',
      'download',
      'my-bucket',
      'remote/key',
      dest,
      '--credentials',
      'prod-aws',
    ]);

    expect(downloadBucketObject).toHaveBeenCalledWith('test-token', {
      bucketName: 'my-bucket',
      remotePath: 'remote/key',
      credentialName: 'prod-aws',
    });
    expect(readFileSync(dest)).toEqual(payload);
  });

  it('refetches a clean early EOF and only publishes the complete download', async () => {
    const dest = join(workDir, 'out.bin');
    writeFileSync(dest, 'known-good');
    vi.mocked(downloadBucketObject)
      .mockResolvedValueOnce({
        stream: Readable.from([Buffer.from('cut')]),
        contentLength: 8,
      })
      .mockResolvedValueOnce({
        stream: Readable.from([Buffer.from('complete')]),
        contentLength: 8,
      });
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);

    try {
      await createBucketCommand().parseAsync([
        'node',
        'test',
        'download',
        'my-bucket',
        'remote/key',
        dest,
        '--credentials',
        'prod-aws',
      ]);
    } finally {
      random.mockRestore();
    }

    expect(downloadBucketObject).toHaveBeenCalledTimes(2);
    expect(readFileSync(dest, 'utf8')).toBe('complete');
    expect(readdirSync(workDir)).toEqual(['out.bin']);
  });

  it('fails after three truncated responses without replacing a valid destination', async () => {
    const dest = join(workDir, 'out.bin');
    writeFileSync(dest, 'known-good');
    vi.mocked(downloadBucketObject).mockImplementation(async () => ({
      stream: Readable.from([Buffer.from('cut')]),
      contentLength: 8,
    }));
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);

    try {
      await expect(
        createBucketCommand().parseAsync([
          'node',
          'test',
          'download',
          'my-bucket',
          'remote/key',
          dest,
          '--credentials',
          'prod-aws',
        ]),
      ).rejects.toThrow(/process\.exit:1/);
    } finally {
      random.mockRestore();
    }

    expect(downloadBucketObject).toHaveBeenCalledTimes(3);
    expect(readFileSync(dest, 'utf8')).toBe('known-good');
    expect(readdirSync(workDir)).toEqual(['out.bin']);
    expect(printError).toHaveBeenCalledWith(
      'Download failed: Download was incomplete: expected 8 bytes, received 3',
    );
  });

  it('reports a declared missing object once and exits 1', async () => {
    vi.mocked(downloadBucketObject).mockRejectedValue(
      new ApiHttpError(
        '/v1/credentials/prod-aws/buckets/my-bucket/object-content',
        404,
        'Object not found: my-bucket/remote/key',
        'OBJECT_NOT_FOUND',
      ),
    );

    await expect(
      createBucketCommand().parseAsync([
        'node',
        'test',
        'download',
        'my-bucket',
        'remote/key',
        join(workDir, 'out.bin'),
        '--credentials',
        'prod-aws',
      ]),
    ).rejects.toThrow(/process\.exit:1/);
    expect(printError).toHaveBeenCalledWith(
      'Download failed: Object not found: my-bucket/remote/key',
    );
    expect(downloadBucketObject).toHaveBeenCalledTimes(1);
    expect(existsSync(join(workDir, 'out.bin'))).toBe(false);
  });

  it('download exits non-zero when the API call fails', async () => {
    vi.mocked(downloadBucketObject).mockRejectedValue(new Error('boom'));
    const dest = join(workDir, 'out.bin');

    await expect(
      createBucketCommand().parseAsync([
        'node',
        'test',
        'download',
        'my-bucket',
        'remote/key',
        dest,
        '--credentials',
        'prod-aws',
      ]),
    ).rejects.toThrow(/process\.exit:1/);
  });

  it('exhausts pages and atomically downloads a recursive prefix', async () => {
    vi.mocked(listBucketObjects)
      .mockResolvedValueOnce({
        entries: [
          {
            kind: 'object',
            key: 'models/z.txt',
            sizeBytes: 1,
            lastModifiedAt: null,
          },
          {
            kind: 'object',
            key: 'models/empty/',
            sizeBytes: 0,
            lastModifiedAt: null,
          },
        ],
        nextCursor: 'next',
      })
      .mockResolvedValueOnce({
        entries: [
          {
            kind: 'object',
            key: 'models/nested/a.txt',
            sizeBytes: 3,
            lastModifiedAt: null,
          },
        ],
        nextCursor: null,
      });
    vi.mocked(downloadBucketObject).mockImplementation(
      async (_token, params) => {
        const key = params?.remotePath ?? '';
        return {
          stream: Readable.from([
            key.endsWith('a.txt') ? Buffer.from('aaa') : Buffer.from('z'),
          ]),
          contentLength: key.endsWith('a.txt') ? 3 : 1,
        };
      },
    );
    const destination = join(workDir, 'download');

    await createBucketCommand().parseAsync([
      'node',
      'test',
      'download',
      'my-bucket',
      'models/',
      destination,
      '--recursive',
      '--credentials',
      'prod-aws',
    ]);

    expect(readFileSync(join(destination, 'z.txt'), 'utf8')).toBe('z');
    expect(readFileSync(join(destination, 'nested', 'a.txt'), 'utf8')).toBe(
      'aaa',
    );
    expect(existsSync(join(destination, 'empty'))).toBe(true);
    expect(listBucketObjects).toHaveBeenNthCalledWith(
      2,
      'test-token',
      expect.objectContaining({ cursor: 'next' }),
    );
  });

  it('uses listing size to detect and retry a truncated recursive download', async () => {
    vi.mocked(listBucketObjects).mockResolvedValue({
      entries: [
        {
          kind: 'object',
          key: 'models/model.bin',
          sizeBytes: 8,
          lastModifiedAt: null,
        },
      ],
      nextCursor: null,
    });
    vi.mocked(downloadBucketObject)
      .mockResolvedValueOnce({
        stream: Readable.from([Buffer.from('cut')]),
        contentLength: undefined,
      })
      .mockResolvedValueOnce({
        stream: Readable.from([Buffer.from('complete')]),
        contentLength: undefined,
      });
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    const destination = join(workDir, 'download');

    try {
      await createBucketCommand().parseAsync([
        'node',
        'test',
        'download',
        'my-bucket',
        'models/',
        destination,
        '--recursive',
        '--credentials',
        'prod-aws',
      ]);
    } finally {
      random.mockRestore();
    }

    expect(downloadBucketObject).toHaveBeenCalledTimes(2);
    expect(readFileSync(join(destination, 'model.bin'), 'utf8')).toBe(
      'complete',
    );
  });

  it('maps a recursive bucket-root download without rewriting object keys', async () => {
    vi.mocked(listBucketObjects).mockResolvedValue({
      entries: [
        {
          kind: 'object',
          key: 'root.txt',
          sizeBytes: 4,
          lastModifiedAt: null,
        },
        {
          kind: 'object',
          key: 'nested/value.txt',
          sizeBytes: 6,
          lastModifiedAt: null,
        },
      ],
      nextCursor: null,
    });
    vi.mocked(downloadBucketObject).mockImplementation(
      async (_token, params) => ({
        stream: Readable.from([
          Buffer.from(params?.remotePath === 'root.txt' ? 'root' : 'nested'),
        ]),
        contentLength: params?.remotePath === 'root.txt' ? 4 : 6,
      }),
    );
    const destination = join(workDir, 'download-root');

    await createBucketCommand().parseAsync([
      'node',
      'test',
      'download',
      'my-bucket',
      '',
      destination,
      '--recursive',
      '--credentials',
      'prod-aws',
    ]);

    expect(readFileSync(join(destination, 'root.txt'), 'utf8')).toBe('root');
    expect(readFileSync(join(destination, 'nested', 'value.txt'), 'utf8')).toBe(
      'nested',
    );
    expect(listBucketObjects).toHaveBeenCalledWith(
      'test-token',
      expect.objectContaining({ prefix: '', recursive: true }),
    );
  });

  it('succeeds without downloads for an empty recursive prefix', async () => {
    vi.mocked(listBucketObjects).mockResolvedValue({
      entries: [],
      nextCursor: null,
    });
    const destination = join(workDir, 'empty-download');

    await createBucketCommand().parseAsync([
      'node',
      'test',
      'download',
      'my-bucket',
      'empty/',
      destination,
      '--recursive',
      '--credentials',
      'prod-aws',
    ]);

    expect(downloadBucketObject).not.toHaveBeenCalled();
    expect(printSuccess).toHaveBeenCalledWith(
      `Downloaded 0/0 object(s), 0 B to ${destination}`,
    );
  });

  it('rejects an unsafe remote key before downloading anything', async () => {
    vi.mocked(listBucketObjects).mockResolvedValue({
      entries: [
        {
          kind: 'object',
          key: 'models/../escape',
          sizeBytes: 1,
          lastModifiedAt: null,
        },
      ],
      nextCursor: null,
    });

    await expect(
      createBucketCommand().parseAsync([
        'node',
        'test',
        'download',
        'my-bucket',
        'models/',
        join(workDir, 'download'),
        '--recursive',
        '--credentials',
        'prod-aws',
      ]),
    ).rejects.toThrow(/process\.exit:1/);
    expect(downloadBucketObject).not.toHaveBeenCalled();
  });

  it('attempts every recursive download and reports failures in manifest order', async () => {
    vi.mocked(listBucketObjects).mockResolvedValue({
      entries: ['c', 'a', 'b'].map((name) => ({
        kind: 'object',
        key: `models/${name}`,
        sizeBytes: 1,
        lastModifiedAt: null,
      })),
      nextCursor: null,
    });
    vi.mocked(downloadBucketObject).mockImplementation(
      async (_token, params) => {
        if (params?.remotePath !== 'models/b') {
          throw new Error(`denied ${params?.remotePath}`);
        }
        return { stream: Readable.from([Buffer.from('b')]), contentLength: 1 };
      },
    );
    const destination = join(workDir, 'download');

    await expect(
      createBucketCommand().parseAsync([
        'node',
        'test',
        'download',
        'my-bucket',
        'models/',
        destination,
        '--recursive',
        '--concurrency',
        '2',
        '--credentials',
        'prod-aws',
      ]),
    ).rejects.toThrow(/process\.exit:1/);

    expect(downloadBucketObject).toHaveBeenCalledTimes(3);
    expect(readFileSync(join(destination, 'b'), 'utf8')).toBe('b');
    expect(
      vi.mocked(printError).mock.calls.map(([message]) => message),
    ).toEqual([
      'Recursive download partially failed: 1/3 object(s), 1 B',
      'models/a: denied models/a',
      'models/c: denied models/c',
    ]);
  });

  it('rejects recursive-only download options and invalid destinations', async () => {
    const destination = join(workDir, 'destination');
    writeFileSync(destination, 'not-a-directory');

    await expect(
      createBucketCommand().parseAsync([
        'node',
        'test',
        'download',
        'my-bucket',
        'single-key',
        destination,
        '--concurrency',
        '2',
        '--credentials',
        'prod-aws',
      ]),
    ).rejects.toThrow(/process\.exit:1/);

    await expect(
      createBucketCommand().parseAsync([
        'node',
        'test',
        'download',
        'my-bucket',
        'models',
        destination,
        '--recursive',
        '--credentials',
        'prod-aws',
      ]),
    ).rejects.toThrow(/process\.exit:1/);

    vi.mocked(listBucketObjects).mockResolvedValueOnce({
      entries: [],
      nextCursor: null,
    });
    await expect(
      createBucketCommand().parseAsync([
        'node',
        'test',
        'download',
        'my-bucket',
        'models/',
        destination,
        '--recursive',
        '--credentials',
        'prod-aws',
      ]),
    ).rejects.toThrow(/process\.exit:1/);

    expect(downloadBucketObject).not.toHaveBeenCalled();
  });
});

describe('createBucketCommand rm', () => {
  let exitSpy: MockInstance<typeof process.exit>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(shouldAllowPrompts).mockReturnValue(false);
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit:${code ?? 0}`);
      });
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('forwards bucket/key/credentials/region to the object delete endpoint', async () => {
    vi.mocked(deleteBucketObject).mockResolvedValue(undefined);

    await createBucketCommand().parseAsync([
      'node',
      'test',
      'rm',
      'my-bucket',
      'remote/key',
      '--credentials',
      'prod-aws',
      '--region',
      'us-east-1',
    ]);

    expect(deleteBucketObject).toHaveBeenCalledWith('test-token', {
      bucketName: 'my-bucket',
      remotePath: 'remote/key',
      credentialName: 'prod-aws',
      region: 'us-east-1',
    });
  });

  it('rm exits non-zero when the API call fails', async () => {
    vi.mocked(deleteBucketObject).mockRejectedValue(new Error('forbidden'));

    await expect(
      createBucketCommand().parseAsync([
        'node',
        'test',
        'rm',
        'my-bucket',
        'remote/key',
        '--credentials',
        'prod-aws',
      ]),
    ).rejects.toThrow(/process\.exit:1/);
  });

  it('requires --yes for recursive deletion in non-interactive mode', async () => {
    vi.mocked(listBucketObjects).mockResolvedValue({
      entries: [
        {
          kind: 'object',
          key: 'old/a',
          sizeBytes: 1,
          lastModifiedAt: null,
        },
      ],
      nextCursor: null,
    });

    await expect(
      createBucketCommand().parseAsync([
        'node',
        'test',
        'rm',
        'my-bucket',
        'old/',
        '--recursive',
        '--credentials',
        'prod-aws',
      ]),
    ).rejects.toThrow(/process\.exit:1/);
    expect(deleteBucketObject).not.toHaveBeenCalled();
  });

  it('treats an empty recursive deletion result as an idempotent success', async () => {
    vi.mocked(listBucketObjects).mockResolvedValue({
      entries: [],
      nextCursor: null,
    });

    await createBucketCommand().parseAsync([
      'node',
      'test',
      'rm',
      'my-bucket',
      'old/',
      '--recursive',
      '--credentials',
      'prod-aws',
    ]);

    expect(safePrompts).not.toHaveBeenCalled();
    expect(deleteBucketObject).not.toHaveBeenCalled();
  });

  it('allows an interactive user to cancel without deleting', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    vi.mocked(safePrompts).mockResolvedValueOnce({ confirmed: false });
    vi.mocked(listBucketObjects).mockResolvedValue({
      entries: [
        {
          kind: 'object',
          key: 'old/a',
          sizeBytes: 1,
          lastModifiedAt: null,
        },
      ],
      nextCursor: null,
    });

    await createBucketCommand().parseAsync([
      'node',
      'test',
      'rm',
      'my-bucket',
      'old/',
      '--recursive',
      '--credentials',
      'prod-aws',
    ]);

    expect(safePrompts).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'confirm', initial: false }),
    );
    expect(deleteBucketObject).not.toHaveBeenCalled();
  });

  it('shows count and known bytes before an interactive confirmed delete', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    vi.mocked(safePrompts).mockResolvedValueOnce({ confirmed: true });
    vi.mocked(deleteBucketObject).mockResolvedValue(undefined);
    vi.mocked(listBucketObjects).mockResolvedValue({
      entries: [
        {
          kind: 'object',
          key: 'old/a',
          sizeBytes: 1,
          lastModifiedAt: null,
        },
        {
          kind: 'object',
          key: 'old/b',
          sizeBytes: 2,
          lastModifiedAt: null,
        },
      ],
      nextCursor: null,
    });

    await createBucketCommand().parseAsync([
      'node',
      'test',
      'rm',
      'my-bucket',
      'old/',
      '--recursive',
      '--credentials',
      'prod-aws',
    ]);

    expect(safePrompts).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Delete 2 object(s) (3 B) under my-bucket/old/?',
      }),
    );
    expect(deleteBucketObject).toHaveBeenCalledTimes(2);
  });

  it('attempts every recursive delete and reports ordered failures', async () => {
    vi.mocked(listBucketObjects).mockResolvedValue({
      entries: [
        {
          kind: 'object',
          key: 'old/c',
          sizeBytes: null,
          lastModifiedAt: null,
        },
        {
          kind: 'object',
          key: 'old/a',
          sizeBytes: 1,
          lastModifiedAt: null,
        },
        {
          kind: 'object',
          key: 'old/b',
          sizeBytes: 1,
          lastModifiedAt: null,
        },
      ],
      nextCursor: null,
    });
    vi.mocked(deleteBucketObject).mockImplementation(
      async (_token, request) => {
        if (request.remotePath === 'old/b') throw new Error('denied');
      },
    );

    await expect(
      createBucketCommand().parseAsync([
        'node',
        'test',
        'rm',
        'my-bucket',
        'old/',
        '--recursive',
        '--yes',
        '--concurrency',
        '2',
        '--credentials',
        'prod-aws',
      ]),
    ).rejects.toThrow(/process\.exit:1/);

    expect(deleteBucketObject).toHaveBeenCalledTimes(3);
    expect(printError).toHaveBeenCalledWith(expect.stringContaining('old/b'));
  });

  it('rejects empty and non-folder recursive delete prefixes', async () => {
    for (const prefix of ['', 'old']) {
      await expect(
        createBucketCommand().parseAsync([
          'node',
          'test',
          'rm',
          'my-bucket',
          prefix,
          '--recursive',
          '--yes',
          '--credentials',
          'prod-aws',
        ]),
      ).rejects.toThrow(/process\.exit:1/);
    }
    expect(listBucketObjects).not.toHaveBeenCalled();
  });

  it('rejects --yes and --concurrency without recursive deletion', async () => {
    for (const option of [['--yes'], ['--concurrency', '2']]) {
      await expect(
        createBucketCommand().parseAsync([
          'node',
          'test',
          'rm',
          'my-bucket',
          'single-key',
          ...option,
          '--credentials',
          'prod-aws',
        ]),
      ).rejects.toThrow(/process\.exit:1/);
    }
    expect(deleteBucketObject).not.toHaveBeenCalled();
  });
});

describe('createBucketCommand exists', () => {
  let exitSpy: MockInstance<typeof process.exit>;

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit:${code ?? 0}`);
      });
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('exits zero when the bucket exists', async () => {
    vi.mocked(bucketExists).mockResolvedValue({ exists: true });

    await createBucketCommand().parseAsync([
      'node',
      'test',
      'exists',
      'my-bucket',
      '--credentials',
      'prod-gcp',
      '--region',
      'us-central1',
    ]);

    expect(bucketExists).toHaveBeenCalledWith('test-token', {
      bucketName: 'my-bucket',
      credentialName: 'prod-gcp',
      region: 'us-central1',
    });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits 1 when the bucket does not exist', async () => {
    vi.mocked(bucketExists).mockRejectedValue(
      new ORPCError('BUCKET_NOT_FOUND', { status: 404 }),
    );

    await expect(
      createBucketCommand().parseAsync([
        'node',
        'test',
        'exists',
        'my-bucket',
        '--credentials',
        'prod-aws',
      ]),
    ).rejects.toThrow(/process\.exit:1/);
  });

  it('exits 2 when the existence check fails', async () => {
    vi.mocked(bucketExists).mockRejectedValue(new Error('boom'));

    await expect(
      createBucketCommand().parseAsync([
        'node',
        'test',
        'exists',
        'my-bucket',
        '--credentials',
        'prod-aws',
      ]),
    ).rejects.toThrow(/process\.exit:2/);
  });
});

describe('createBucketCommand list', () => {
  let exitSpy: MockInstance<typeof process.exit>;
  let logSpy: MockInstance<typeof console.log>;

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit:${code ?? 0}`);
      });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    process.exitCode = undefined;
  });

  it('lists buckets as sorted compact JSON', async () => {
    vi.mocked(listBuckets).mockResolvedValue({
      buckets: [
        { name: 'z-bucket', region: null, createdAt: null },
        { name: 'a-bucket', region: 'us-east-1', createdAt: 123 },
      ],
      nextCursor: null,
    });

    await createBucketCommand().parseAsync([
      'node',
      'test',
      'list',
      '--credentials',
      'prod-aws',
      '--json',
    ]);

    expect(listBuckets).toHaveBeenCalledWith('test-token', {
      credentialName: 'prod-aws',
      pageSize: 1000,
    });
    expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toEqual({
      entries: [
        { name: 'a-bucket', region: 'us-east-1', createdAt: 123 },
        { name: 'z-bucket', region: null, createdAt: null },
      ],
      truncated: false,
      nextCursor: null,
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBeUndefined();
  });

  it('auto-selects the only credential for bucket discovery', async () => {
    vi.mocked(listApiCredentials).mockResolvedValueOnce([
      { name: 'solo-azure', cloudProvider: CloudType.Azure },
    ]);
    vi.mocked(listBuckets).mockResolvedValue({
      buckets: [],
      nextCursor: null,
    });

    await createBucketCommand().parseAsync(['node', 'test', 'list', '--json']);

    expect(listBuckets).toHaveBeenCalledWith(
      'test-token',
      expect.objectContaining({ credentialName: 'solo-azure' }),
    );
  });

  it('renders a sorted bucket table and handles an empty result', async () => {
    vi.mocked(listBuckets)
      .mockResolvedValueOnce({
        buckets: [
          { name: 'z-bucket', region: null, createdAt: null },
          { name: 'a-bucket', region: 'us-east-1', createdAt: 123 },
        ],
        nextCursor: null,
      })
      .mockResolvedValueOnce({ buckets: [], nextCursor: null });

    await createBucketCommand().parseAsync([
      'node',
      'test',
      'list',
      '--credentials',
      'prod-aws',
    ]);
    const tableOutput = logSpy.mock.calls.flat().join('\n');
    expect(tableOutput.indexOf('a-bucket')).toBeLessThan(
      tableOutput.indexOf('z-bucket'),
    );

    logSpy.mockClear();
    await createBucketCommand().parseAsync([
      'node',
      'test',
      'list',
      '--credentials',
      'prod-aws',
    ]);
    expect(printInfo).toHaveBeenCalledWith('No buckets found.');
  });

  it('renders whole-second UTC timestamps regardless of provider precision', async () => {
    vi.mocked(listBuckets).mockResolvedValue({
      buckets: [
        { name: 'exact', region: null, createdAt: 1735689600000 },
        { name: 'sub-second', region: null, createdAt: 1735689600456 },
      ],
      nextCursor: null,
    });

    await createBucketCommand().parseAsync([
      'node',
      'test',
      'list',
      '--credentials',
      'prod-aws',
    ]);

    const tableOutput = logSpy.mock.calls.flat().join('\n');
    expect(tableOutput).toContain('2025-01-01 00:00:00 UTC');
    expect(tableOutput).not.toContain('.456Z');
  });

  it('does not warn about truncation when a full page ends the listing', async () => {
    // Azure reports an exhausted listing with an empty continuation token.
    vi.mocked(listBuckets).mockResolvedValue({
      buckets: [{ name: 'only', region: null, createdAt: null }],
      nextCursor: '',
    });

    await createBucketCommand().parseAsync([
      'node',
      'test',
      'list',
      '--credentials',
      'prod-aws',
      '--limit',
      '1',
      '--json',
    ]);

    expect(printWarning).not.toHaveBeenCalled();
    expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toMatchObject({
      truncated: false,
      nextCursor: null,
    });
    expect(process.exitCode).toBeUndefined();
  });

  it('--all follows cursors until the bucket listing is complete', async () => {
    vi.mocked(listBuckets)
      .mockResolvedValueOnce({
        buckets: [{ name: 'b', region: null, createdAt: null }],
        nextCursor: 'next-page',
      })
      .mockResolvedValueOnce({
        buckets: [{ name: 'a', region: null, createdAt: null }],
        nextCursor: null,
      });

    await createBucketCommand().parseAsync([
      'node',
      'test',
      'list',
      '--credentials',
      'prod-aws',
      '--all',
      '--json',
    ]);

    expect(listBuckets).toHaveBeenCalledTimes(2);
    expect(listBuckets).toHaveBeenLastCalledWith(
      'test-token',
      expect.objectContaining({ cursor: 'next-page' }),
    );
    const payload = JSON.parse(String(logSpy.mock.calls[0][0])) as {
      entries: Array<{ name: string }>;
    };
    expect(payload.entries.map((bucket) => bucket.name)).toEqual(['a', 'b']);
  });

  it('--limit spans API pages and reduces the final page size', async () => {
    vi.mocked(listBuckets)
      .mockResolvedValueOnce({
        buckets: [
          { name: 'c', region: null, createdAt: null },
          { name: 'b', region: null, createdAt: null },
        ],
        nextCursor: 'next-page',
      })
      .mockResolvedValueOnce({
        buckets: [{ name: 'a', region: null, createdAt: null }],
        nextCursor: 'more',
      });

    await createBucketCommand().parseAsync([
      'node',
      'test',
      'list',
      '--credentials',
      'prod-aws',
      '--limit',
      '3',
      '--json',
    ]);

    expect(listBuckets).toHaveBeenNthCalledWith(
      2,
      'test-token',
      expect.objectContaining({ pageSize: 1, cursor: 'next-page' }),
    );
    const payload = JSON.parse(String(logSpy.mock.calls[0][0])) as {
      entries: Array<{ name: string }>;
      truncated: boolean;
      nextCursor: string | null;
    };
    expect(payload.entries.map((bucket) => bucket.name)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(payload).toMatchObject({ truncated: true, nextCursor: 'more' });
  });

  it.each([[['--json']], [[]]])(
    'warns and exits 3 when the limit truncates results (%j)',
    async (format) => {
      vi.mocked(listBuckets).mockResolvedValue({
        buckets: [{ name: 'a', region: null, createdAt: null }],
        nextCursor: 'more',
      });

      await createBucketCommand().parseAsync([
        'node',
        'test',
        'list',
        '--credentials',
        'prod-aws',
        '--limit',
        '1',
        ...format,
      ]);

      expect(printWarning).toHaveBeenCalledWith(
        expect.stringMatching(/use --all.*--cursor 'more'/),
        true,
      );
      expect(process.exitCode).toBe(3);
    },
  );

  it('reports a missing bucket and exits 1', async () => {
    vi.mocked(listBucketObjects).mockRejectedValue(
      new ORPCError('BUCKET_NOT_FOUND', {
        status: 404,
        message: 'Bucket not found: gone',
      }),
    );

    await expect(
      createBucketCommand().parseAsync([
        'node',
        'test',
        'list',
        'gone',
        '--credentials',
        'prod-aws',
      ]),
    ).rejects.toThrow(/process\.exit:1/);
    expect(printError).toHaveBeenCalledWith(
      'List failed: Bucket not found: gone',
    );
    expect(listBucketObjects).toHaveBeenCalledTimes(1);
  });

  it('refuses a page larger than requested rather than expose a cursor past dropped items', async () => {
    vi.mocked(listBuckets).mockResolvedValue({
      buckets: [
        { name: 'a', region: null, createdAt: null },
        { name: 'b', region: null, createdAt: null },
      ],
      nextCursor: 'past-b',
    });

    await expect(
      createBucketCommand().parseAsync([
        'node',
        'test',
        'list',
        '--credentials',
        'prod-aws',
        '--limit',
        '1',
        '--json',
      ]),
    ).rejects.toThrow(/process\.exit:1/);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('--cursor resumes a capped listing so every key arrives exactly once', async () => {
    const keys = Array.from(
      { length: 11 },
      (_, i) => `k/${String(i).padStart(2, '0')}`,
    );
    // A provider that honours pageSize and resumes at an opaque offset cursor.
    vi.mocked(listBucketObjects).mockImplementation(
      async (_token, { pageSize, cursor }) => {
        const start = cursor === undefined ? 0 : Number(cursor.slice(1));
        const end = Math.min(keys.length, start + pageSize);
        return {
          entries: keys.slice(start, end).map((key) => ({
            kind: 'object' as const,
            key,
            sizeBytes: 1,
            lastModifiedAt: null,
          })),
          nextCursor: end < keys.length ? `@${end}` : null,
        };
      },
    );

    const seen: string[] = [];
    const exitCodes: unknown[] = [];
    let cursor: string | null = null;
    do {
      logSpy.mockClear();
      process.exitCode = undefined;
      await createBucketCommand().parseAsync([
        'node',
        'test',
        'list',
        'my-bucket',
        'k/',
        '--recursive',
        '--credentials',
        'prod-aws',
        '--limit',
        '4',
        '--json',
        ...(cursor === null ? [] : ['--cursor', cursor]),
      ]);
      const payload = JSON.parse(String(logSpy.mock.calls[0][0])) as {
        entries: Array<{ key: string }>;
        truncated: boolean;
        nextCursor: string | null;
      };
      expect(payload.truncated).toBe(payload.nextCursor !== null);
      seen.push(...payload.entries.map((entry) => entry.key));
      exitCodes.push(process.exitCode);
      cursor = payload.nextCursor;
    } while (cursor !== null);

    expect(seen).toEqual(keys);
    expect(exitCodes).toEqual([3, 3, undefined]);
  });

  it('--all with --cursor fetches the rest of the listing', async () => {
    vi.mocked(listBuckets)
      .mockResolvedValueOnce({
        buckets: [{ name: 'b', region: null, createdAt: null }],
        nextCursor: 'next-page',
      })
      .mockResolvedValueOnce({
        buckets: [{ name: 'c', region: null, createdAt: null }],
        nextCursor: null,
      });

    await createBucketCommand().parseAsync([
      'node',
      'test',
      'list',
      '--credentials',
      'prod-aws',
      '--all',
      '--cursor',
      'after-a',
      '--json',
    ]);

    expect(listBuckets).toHaveBeenNthCalledWith(
      1,
      'test-token',
      expect.objectContaining({ pageSize: 1000, cursor: 'after-a' }),
    );
    expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toMatchObject({
      truncated: false,
      nextCursor: null,
    });
    expect(process.exitCode).toBeUndefined();
  });

  it('lists a bucket prefix recursively through the object endpoint', async () => {
    vi.mocked(listBucketObjects).mockResolvedValue({
      entries: [
        {
          kind: 'object',
          key: 'models/b.bin',
          sizeBytes: 2,
          lastModifiedAt: 3,
        },
      ],
      nextCursor: null,
    });

    await createBucketCommand().parseAsync([
      'node',
      'test',
      'list',
      'my-bucket',
      'models/',
      '--recursive',
      '--credentials',
      'prod-gcp',
      '--region',
      'us-central1',
      '--json',
    ]);

    expect(listBucketObjects).toHaveBeenCalledWith('test-token', {
      credentialName: 'prod-gcp',
      region: 'us-central1',
      bucketName: 'my-bucket',
      pageSize: 1000,
      recursive: true,
      prefix: 'models/',
    });
    expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toEqual({
      entries: [
        {
          kind: 'object',
          key: 'models/b.bin',
          sizeBytes: 2,
          lastModifiedAt: 3,
        },
      ],
      truncated: false,
      nextCursor: null,
    });
  });

  it('uses hierarchical mode for a bucket with no prefix', async () => {
    vi.mocked(listBucketObjects).mockResolvedValue({
      entries: [
        { kind: 'prefix', key: 'models/' },
        {
          kind: 'object',
          key: 'README',
          sizeBytes: null,
          lastModifiedAt: null,
        },
      ],
      nextCursor: null,
    });

    await createBucketCommand().parseAsync([
      'node',
      'test',
      'list',
      'my-bucket',
      '--credentials',
      'prod-aws',
      '--json',
    ]);

    expect(listBucketObjects).toHaveBeenCalledWith('test-token', {
      credentialName: 'prod-aws',
      bucketName: 'my-bucket',
      pageSize: 1000,
      recursive: false,
    });
  });

  it('fails without emitting a partial JSON result when a later page fails', async () => {
    vi.mocked(listBuckets)
      .mockResolvedValueOnce({
        buckets: [{ name: 'a', region: null, createdAt: null }],
        nextCursor: 'next-page',
      })
      .mockRejectedValueOnce(new Error('provider unavailable'));

    await expect(
      createBucketCommand().parseAsync([
        'node',
        'test',
        'list',
        '--credentials',
        'prod-aws',
        '--all',
        '--json',
      ]),
    ).rejects.toThrow(/process\.exit:1/);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('rejects --recursive without a bucket', async () => {
    await expect(
      createBucketCommand().parseAsync([
        'node',
        'test',
        'list',
        '--recursive',
        '--credentials',
        'prod-aws',
      ]),
    ).rejects.toThrow(/process\.exit:1/);
    expect(listBuckets).not.toHaveBeenCalled();
    expect(listBucketObjects).not.toHaveBeenCalled();
  });

  it('rejects --all combined with --limit', async () => {
    await expect(
      createBucketCommand().parseAsync([
        'node',
        'test',
        'list',
        '--all',
        '--limit',
        '2',
        '--credentials',
        'prod-aws',
      ]),
    ).rejects.toThrow(/process\.exit:1/);
    expect(listBuckets).not.toHaveBeenCalled();
    expect(listBucketObjects).not.toHaveBeenCalled();
  });

  it.each(['0', '-1', '1.5', 'many'])(
    'rejects invalid --limit %s',
    async (limit) => {
      await expect(
        createBucketCommand().parseAsync([
          'node',
          'test',
          'list',
          '--limit',
          limit,
          '--credentials',
          'prod-aws',
        ]),
      ).rejects.toThrow(/process\.exit:1/);
      expect(listBuckets).not.toHaveBeenCalled();
      expect(listBucketObjects).not.toHaveBeenCalled();
    },
  );
});
