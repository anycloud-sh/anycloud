import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from 'vitest';

const api = vi.hoisted(() => ({ query: vi.fn(), schema: vi.fn() }));

vi.mock('../../../src/cli/utils/output.js', async (importActual) => {
  const actual =
    await importActual<typeof import('../../../src/cli/utils/output.js')>();
  return {
    ...actual,
    printInfo: vi.fn(),
    printWarning: vi.fn(),
    printError: vi.fn(),
  };
});

vi.mock('../../../src/cli/services/auth.js', async () =>
  (await import('./cli-auth-mock.js')).cliAuthMock('mock-token'),
);

vi.mock('../../../src/shared/services/api-client/rpc.js', () => ({
  createApiClient: () => ({ database: api }),
}));

import { createDbQueryCommand } from '../../../src/cli/commands/db/query.js';
import { createDbSchemaCommand } from '../../../src/cli/commands/db/schema.js';
import { setJsonMode } from '../../../src/cli/utils/output.js';

const dbQuery = api.query;
const getDbSchema = api.schema;

describe('createDbQueryCommand', () => {
  let exitSpy: MockInstance<typeof process.exit>;
  let logSpy: MockInstance<typeof console.log>;

  beforeEach(() => {
    vi.clearAllMocks();
    setJsonMode(false);
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit:${code ?? 0}`);
      });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    setJsonMode(false);
    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('passes the SQL through to the API client', async () => {
    vi.mocked(dbQuery).mockResolvedValue({
      rows: [{ id: 'a', state: 'Running' }],
      rowCount: 1,
      truncated: false,
    });
    await createDbQueryCommand().parseAsync([
      'node',
      'test',
      'SELECT id, state FROM workloads',
    ]);
    expect(dbQuery).toHaveBeenCalledWith({
      sql: 'SELECT id, state FROM workloads',
    });
  });

  it('--json emits the full response payload as JSON', async () => {
    const payload = {
      rows: [{ id: 'a' }, { id: 'b' }],
      rowCount: 2,
      truncated: false,
    };
    vi.mocked(dbQuery).mockResolvedValue(payload);
    await createDbQueryCommand().parseAsync([
      'node',
      'test',
      'SELECT id FROM workloads',
      '--json',
    ]);
    const stdout = logSpy.mock.calls.map((c) => String(c[0]));
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0])).toEqual(payload);
  });

  it('exits non-zero when the API rejects the query', async () => {
    vi.mocked(dbQuery).mockRejectedValue(
      new Error(
        'Only SELECT, WITH, EXPLAIN, and PRAGMA statements are allowed (got DELETE)',
      ),
    );
    await expect(
      createDbQueryCommand().parseAsync([
        'node',
        'test',
        'DELETE FROM workloads',
      ]),
    ).rejects.toThrow('process.exit:1');
  });
});

describe('createDbSchemaCommand', () => {
  let exitSpy: MockInstance<typeof process.exit>;
  let logSpy: MockInstance<typeof console.log>;

  beforeEach(() => {
    vi.clearAllMocks();
    setJsonMode(false);
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit:${code ?? 0}`);
      });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    setJsonMode(false);
    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('passes table arg to the API client', async () => {
    vi.mocked(getDbSchema).mockResolvedValue({ tables: [] });
    await createDbSchemaCommand().parseAsync([
      'node',
      'test',
      'workloads',
      '--json',
    ]);
    expect(getDbSchema).toHaveBeenCalledWith({
      query: { table: 'workloads' },
    });
  });

  it('omits table arg when not provided', async () => {
    vi.mocked(getDbSchema).mockResolvedValue({ tables: [] });
    await createDbSchemaCommand().parseAsync(['node', 'test', '--json']);
    expect(getDbSchema).toHaveBeenCalledWith({
      query: {},
    });
  });

  it('--json emits structured schema', async () => {
    const payload = {
      tables: [
        {
          name: 'workloads',
          type: 'table' as const,
          columns: [
            {
              name: 'id',
              type: 'TEXT',
              notNull: true as const,
              primaryKey: true as const,
            },
          ],
        },
      ],
    };
    vi.mocked(getDbSchema).mockResolvedValue(payload);
    await createDbSchemaCommand().parseAsync(['node', 'test', '--json']);
    const stdout = logSpy.mock.calls.map((c) => String(c[0]));
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0])).toEqual(payload);
  });
});
