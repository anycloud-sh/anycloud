import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from 'vitest';

vi.mock('../../../src/cli/utils/output.js', async (importActual) => {
  const actual =
    await importActual<typeof import('../../../src/cli/utils/output.js')>();
  return {
    ...actual,
    createSpinner: () => ({ start: () => ({ stop: () => undefined }) }),
    exitWithError: (msg: string) => {
      throw new Error(msg);
    },
    printInfo: vi.fn(),
    printWarning: vi.fn(),
  };
});

vi.mock('../../../src/cli/services/auth.js', () => ({
  getGitHubToken: () => Promise.resolve('gh-token'),
}));

vi.mock('../../../src/cli/utils/safe-prompts.js', () => ({
  safePrompts: vi.fn(),
  shouldAllowPrompts: vi.fn(),
}));

vi.mock('../../../src/cli/commands/shared.js', () => ({}));

import { createImagesCommand } from '../../../src/cli/commands/images.js';
import { setJsonMode } from '../../../src/cli/utils/output.js';
import {
  safePrompts,
  shouldAllowPrompts,
} from '../../../src/cli/utils/safe-prompts.js';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockGhcrFetch(): MockInstance<typeof fetch> {
  return vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
    const parsed = new URL(String(url));

    if (parsed.pathname === '/user') {
      return jsonResponse({ login: 'Alice' });
    }

    if (parsed.pathname === '/user/packages') {
      return jsonResponse([{ name: 'WebApp' }]);
    }

    if (parsed.pathname === '/user/orgs') {
      return jsonResponse([{ login: 'AnyCloud-Sh' }]);
    }

    if (parsed.pathname === '/orgs/AnyCloud-Sh/packages') {
      return jsonResponse([{ name: 'trainer' }]);
    }

    if (parsed.pathname === '/user/packages/container/WebApp/versions') {
      return jsonResponse([
        { metadata: { container: { tags: ['latest', 'v1'] } } },
      ]);
    }

    if (
      parsed.pathname ===
      '/orgs/anycloud-sh/packages/container/trainer/versions'
    ) {
      return jsonResponse([{ metadata: { container: { tags: ['cuda'] } } }]);
    }

    throw new Error(`Unexpected fetch: ${String(url)}`);
  });
}

describe('createImagesCommand', () => {
  let fetchSpy: MockInstance<typeof fetch>;
  let logSpy: MockInstance<typeof console.log>;
  let errSpy: MockInstance<typeof console.error>;

  beforeEach(() => {
    vi.clearAllMocks();
    setJsonMode(false);
    vi.mocked(shouldAllowPrompts).mockReturnValue(false);
    fetchSpy = mockGhcrFetch();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    setJsonMode(false);
    fetchSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('--only-refs prints full GHCR refs without deploying anything', async () => {
    await createImagesCommand().parseAsync(['node', 'test', '--only-refs']);

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toBe(
      [
        'ghcr.io/alice/webapp:latest',
        'ghcr.io/alice/webapp:v1',
        'ghcr.io/anycloud-sh/trainer:cuda',
      ].join('\n'),
    );
  });

  it('--json emits packages with tags and refs', async () => {
    await createImagesCommand().parseAsync(['node', 'test', '--json']);

    const parsed = JSON.parse(String(logSpy.mock.calls[0][0]));
    expect(parsed).toEqual([
      {
        image: 'ghcr.io/alice/webapp',
        owner: 'alice',
        packageName: 'WebApp',
        scope: 'personal',
        tags: ['latest', 'v1'],
        refs: ['ghcr.io/alice/webapp:latest', 'ghcr.io/alice/webapp:v1'],
      },
      {
        image: 'ghcr.io/anycloud-sh/trainer',
        owner: 'anycloud-sh',
        packageName: 'trainer',
        scope: 'org',
        tags: ['cuda'],
        refs: ['ghcr.io/anycloud-sh/trainer:cuda'],
      },
    ]);
  });

  it('--filter can match a tag', async () => {
    await createImagesCommand().parseAsync([
      'node',
      'test',
      '--json',
      '--filter',
      'cuda',
    ]);

    const parsed = JSON.parse(String(logSpy.mock.calls[0][0]));
    expect(parsed.map((row: { image: string }) => row.image)).toEqual([
      'ghcr.io/anycloud-sh/trainer',
    ]);
  });

  it('--no-tags skips version lookups', async () => {
    await createImagesCommand().parseAsync(['node', 'test', '--no-tags']);

    const paths = fetchSpy.mock.calls.map((call) => {
      const parsed = new URL(String(call[0]));
      return parsed.pathname;
    });
    expect(paths).not.toContain('/user/packages/container/WebApp/versions');
    expect(paths).not.toContain(
      '/orgs/anycloud-sh/packages/container/trainer/versions',
    );
  });

  it('TTY default reuses the GHCR repo/tag picker and prints the selected ref', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    vi.mocked(safePrompts)
      .mockResolvedValueOnce({
        repo: {
          name: 'ghcr.io/alice/webapp',
          owner: 'alice',
          packageName: 'WebApp',
          isOrg: false,
        },
      })
      .mockResolvedValueOnce({ tag: 'v1' });

    await createImagesCommand().parseAsync(['node', 'test']);

    expect(safePrompts).toHaveBeenCalledTimes(2);
    expect(logSpy.mock.calls.map((call) => String(call[0]))).toContain(
      'ghcr.io/alice/webapp:v1',
    );
  });
});
