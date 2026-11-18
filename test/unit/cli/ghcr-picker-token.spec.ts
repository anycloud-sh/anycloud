import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';

const LOCAL_API_TOKEN = 'e'.repeat(64);
const GITHUB_SIGN_IN = 'gho_picker_spec';

const listGitHubPackages = vi.fn();
vi.mock('../../../src/cli/services/ghcr.js', () => ({
  listGitHubPackages: (token: string) => listGitHubPackages(token),
  fetchPackageTags: vi.fn(),
}));
vi.mock('../../../src/cli/utils/safe-prompts.js', () => ({
  safePrompts: vi.fn(),
  shouldAllowPrompts: () => true,
}));

let anycloudDir: string;
let exitSpy: MockInstance<typeof process.exit>;

describe('the GHCR image picker', () => {
  beforeEach(() => {
    vi.resetModules();
    anycloudDir = mkdtempSync(join(tmpdir(), 'anycloud-picker-token-'));
    writeFileSync(join(anycloudDir, 'local-api-token'), LOCAL_API_TOKEN);
    vi.stubEnv('ANYCLOUD_DIR', anycloudDir);
    vi.stubEnv('API_URL', 'http://localhost:8080');
    vi.stubEnv('GITHUB_TOKEN', GITHUB_SIGN_IN);
    listGitHubPackages
      .mockReset()
      .mockResolvedValue({ packages: [], warnings: [] });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit:${code ?? 0}`);
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
    vi.unstubAllEnvs();
    rmSync(anycloudDir, { recursive: true, force: true });
  });

  it.each([
    ['job', 'submit.js', 'createSubmitCommand'],
    ['service', 'serve.js', 'createServeCommand'],
    ['vm', 'vm.js', 'createVmCommand'],
  ] as const)(
    '%s lists GHCR packages with the GitHub sign-in, never the local API token',
    async (_name, file, factory) => {
      const module = (await import(
        `../../../src/cli/commands/${file}`
      )) as Record<string, () => import('commander').Command>;
      const command = module[factory]();
      command.exitOverride();
      await command.parseAsync([], { from: 'user' }).catch(() => undefined);

      expect(listGitHubPackages).toHaveBeenCalledTimes(1);
      expect(listGitHubPackages).toHaveBeenCalledWith(GITHUB_SIGN_IN);
    },
  );
});
