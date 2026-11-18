import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
  execSync: vi.fn(),
}));

vi.mock('../../../src/shared/local-api-container.js', async (importActual) => ({
  ...(await importActual()),
  isLocalApiContainerRunning: vi.fn(),
  getLocalApiContainerHostPort: vi.fn(),
  getLocalApiContainerVersion: vi.fn(),
}));

vi.mock('../../../src/cli/utils/version-check.js', () => ({
  fetchLatestVersion: vi.fn(),
}));

const state = vi.hoisted(() => ({
  anycloudDir: '',
}));

const mocks = vi.hoisted(() => ({
  checkApiVersion: vi.fn(),
}));

vi.mock('../../../src/shared/utils.js', () => ({
  getAnycloudDir: () => state.anycloudDir,
}));

vi.mock('../../../src/shared/services/api-client/runtime.js', () => ({
  checkApiVersion: mocks.checkApiVersion,
}));

vi.mock('../../../src/cli/utils/output.js', async (importActual) => {
  const actual =
    await importActual<typeof import('../../../src/cli/utils/output.js')>();
  return {
    ...actual,
    printInfo: vi.fn(),
    printError: vi.fn(),
    printWarning: vi.fn(),
  };
});

import { execFileSync, execSync } from 'child_process';
import {
  createUpdateCommand,
  isHomebrewManagedPath,
  HOMEBREW_TAP,
  INSTALL_SCRIPT,
} from '../../../src/cli/commands/update.js';
import {
  isLocalApiContainerRunning as isApiContainerRunning,
  getLocalApiContainerHostPort as getContainerHostPort,
  getLocalApiContainerVersion as getVersionFromContainer,
} from '../../../src/shared/local-api-container.js';
import { fetchLatestVersion } from '../../../src/cli/utils/version-check.js';
import {
  printError,
  printInfo,
  printWarning,
} from '../../../src/cli/utils/output.js';
import pkg from '../../../package.json';

const CURRENT_VERSION = pkg.version;
const BIN_DIR = '/home/user/.local/bin';
const BIN = `${BIN_DIR}/anycloud`;
const installArgs = (version: string) => [
  'sh',
  ['-c', INSTALL_SCRIPT, 'sh', BIN_DIR, version],
  { stdio: 'inherit' },
];
const INSTALL_CALL = expect.arrayContaining(['-c', INSTALL_SCRIPT]);
const HOMEBREW_UPDATE_CMD = `brew update && brew upgrade ${HOMEBREW_TAP}`;
const HOMEBREW_VERSION_QUERY_CMD = `brew list --versions ${HOMEBREW_TAP}`;
const BREW_OPT_BIN = `'/opt/homebrew/opt/anycloud/bin/anycloud'`;
const STOP_CMD = `'${BIN}' api stop`;
const LIST_API_IMAGES_ARGS = [
  'image',
  'ls',
  pkg.apiImage,
  '--format',
  '{{.Repository}}\t{{.Tag}}',
];
const startCmd = (version: string) =>
  `'${BIN}' api start --port 8080 --version=${version}`;

async function runUpdate() {
  await createUpdateCommand().parseAsync(['node', 'test']);
}

async function runUpdateExpectingProcessExit(code = 1) {
  const exit = vi.spyOn(process, 'exit').mockImplementation(((
    code?: number,
  ) => {
    throw new Error(`process.exit ${code}`);
  }) as never);
  try {
    await expect(runUpdate()).rejects.toThrow(`process.exit ${code}`);
  } finally {
    exit.mockRestore();
  }
}

function commandWithExitOverride() {
  return createUpdateCommand()
    .exitOverride()
    .configureOutput({ writeErr: () => {}, writeOut: () => {} });
}

describe('createUpdateCommand', () => {
  const originalArgvOne = process.argv[1];
  const originalExecPath = process.execPath;
  const originalExecArgv = process.execArgv;

  beforeEach(() => {
    vi.clearAllMocks();
    process.execPath = BIN;
    process.argv[1] = '/$bunfs/root/anycloud';
    state.anycloudDir = mkdtempSync(join(tmpdir(), 'anycloud-update-'));
    vi.mocked(fetchLatestVersion).mockResolvedValue('9.9.9');
    vi.mocked(execFileSync).mockReturnValue('');
    vi.mocked(isApiContainerRunning).mockReturnValue(true);
    vi.mocked(getContainerHostPort).mockReturnValue(8080);
    vi.mocked(getVersionFromContainer).mockReturnValue(CURRENT_VERSION);
    mocks.checkApiVersion.mockResolvedValue({
      url: 'http://localhost:8080',
      cliVersion: CURRENT_VERSION,
      apiVersion: CURRENT_VERSION,
      compatible: true,
    });
  });

  afterEach(() => {
    process.argv[1] = originalArgvOne;
    process.execPath = originalExecPath;
    process.execArgv = originalExecArgv;
    vi.restoreAllMocks();
    rmSync(state.anycloudDir, { recursive: true, force: true });
  });

  it('rejects version and channel arguments', async () => {
    for (const arg of ['latest', 'stable', '0.1.0']) {
      await expect(
        commandWithExitOverride().parseAsync(['node', 'test', arg]),
      ).rejects.toMatchObject({
        code: 'commander.excessArguments',
      });
    }

    expect(fetchLatestVersion).not.toHaveBeenCalled();
    expect(execSync).not.toHaveBeenCalled();
  });

  it('rejects --no-restart as an unknown option', async () => {
    await expect(
      commandWithExitOverride().parseAsync(['node', 'test', '--no-restart']),
    ).rejects.toMatchObject({
      code: 'commander.unknownOption',
    });

    expect(execSync).not.toHaveBeenCalled();
  });

  it('exposes upgrade as an alias for update', () => {
    expect(createUpdateCommand().aliases()).toContain('upgrade');
  });

  it('installs only the resolved latest release when it is newer', async () => {
    vi.mocked(isApiContainerRunning).mockReturnValue(false);

    await runUpdate();

    expect(fetchLatestVersion).toHaveBeenCalledWith();
    expect(execFileSync).toHaveBeenCalledWith(...installArgs('9.9.9'));
  });

  it('restarts a running API server automatically on the same port after installing a newer release', async () => {
    await runUpdate();

    expect(execFileSync).toHaveBeenCalledWith(...installArgs('9.9.9'));
    expect(execSync).toHaveBeenCalledWith(STOP_CMD, { stdio: 'inherit' });
    expect(execSync).toHaveBeenCalledWith(startCmd('9.9.9'), {
      stdio: 'inherit',
    });
  });

  it('removes older API image versions after a healthy restart while retaining the current and previous versions', async () => {
    vi.mocked(execFileSync).mockReturnValue(
      [
        `${pkg.apiImage}\t9.9.9`,
        `${pkg.apiImage}\t${CURRENT_VERSION}`,
        `${pkg.apiImage}\t0.0.2`,
        `${pkg.apiImage}\t0.0.1`,
        `${pkg.apiImage}\tlatest`,
        `${pkg.apiImage}\tv0.0.3`,
        `example.com/user/api\t0.0.1`,
      ].join('\n'),
    );

    await runUpdate();

    expect(execFileSync).toHaveBeenCalledWith('docker', LIST_API_IMAGES_ARGS, {
      encoding: 'utf-8',
    });
    expect(execFileSync).toHaveBeenCalledWith(
      'docker',
      ['image', 'rm', `${pkg.apiImage}:0.0.2`],
      { stdio: 'ignore' },
    );
    expect(execFileSync).toHaveBeenCalledWith(
      'docker',
      ['image', 'rm', `${pkg.apiImage}:0.0.1`],
      { stdio: 'ignore' },
    );
    for (const protectedRef of [
      `${pkg.apiImage}:9.9.9`,
      `${pkg.apiImage}:${CURRENT_VERSION}`,
      `${pkg.apiImage}:latest`,
      `${pkg.apiImage}:v0.0.3`,
      'example.com/user/api:0.0.1',
    ]) {
      expect(execFileSync).not.toHaveBeenCalledWith(
        'docker',
        ['image', 'rm', protectedRef],
        expect.anything(),
      );
    }
    expect(printInfo).toHaveBeenCalledWith(
      'Removed 2 old local AnyCloud API images.',
    );
  });

  it('keeps the newest older API image when the running API is already current', async () => {
    vi.mocked(fetchLatestVersion).mockResolvedValue(CURRENT_VERSION);
    vi.mocked(execFileSync).mockReturnValue(
      [
        `${pkg.apiImage}\t${CURRENT_VERSION}`,
        `${pkg.apiImage}\t0.0.2`,
        `${pkg.apiImage}\t0.0.1`,
      ].join('\n'),
    );

    await runUpdate();

    expect(execSync).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalledWith(
      'docker',
      ['image', 'rm', `${pkg.apiImage}:0.0.2`],
      expect.anything(),
    );
    expect(execFileSync).toHaveBeenCalledWith(
      'docker',
      ['image', 'rm', `${pkg.apiImage}:0.0.1`],
      { stdio: 'ignore' },
    );
  });

  it('does not fail an otherwise successful update when old API image cleanup fails', async () => {
    vi.mocked(execFileSync).mockImplementation((_file, args) => {
      if (args?.[1] === 'ls') {
        return [
          `${pkg.apiImage}\t${CURRENT_VERSION}`,
          `${pkg.apiImage}\t0.0.1`,
        ].join('\n');
      }
      if (args?.[1] === 'rm') throw new Error('image is in use');
      return '';
    });

    await runUpdate();

    expect(execSync).toHaveBeenCalledWith(startCmd('9.9.9'), {
      stdio: 'inherit',
    });
    expect(printError).not.toHaveBeenCalled();
    expect(printWarning).toHaveBeenCalledWith(
      expect.stringContaining(
        `Could not remove 1 old local AnyCloud API image: ${pkg.apiImage}:0.0.1`,
      ),
    );
  });

  it('does not restart when no API server was running before update', async () => {
    vi.mocked(isApiContainerRunning).mockReturnValue(false);

    await runUpdate();

    expect(execFileSync).toHaveBeenCalledWith(...installArgs('9.9.9'));
    expect(execSync).not.toHaveBeenCalledWith(STOP_CMD, expect.anything());
    expect(execSync).not.toHaveBeenCalledWith(
      expect.stringContaining(' api start'),
      expect.anything(),
    );
  });

  it('updates Homebrew-managed installs through Homebrew', async () => {
    process.execPath = '/opt/homebrew/Cellar/anycloud/0.1.30/bin/anycloud';
    vi.mocked(isApiContainerRunning).mockReturnValue(false);
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === HOMEBREW_VERSION_QUERY_CMD) {
        return `anycloud ${CURRENT_VERSION}`;
      }
      return Buffer.from('');
    });

    await runUpdate();

    expect(execSync).toHaveBeenCalledWith(HOMEBREW_UPDATE_CMD, {
      stdio: 'inherit',
    });
    expect(execSync).toHaveBeenCalledWith(HOMEBREW_VERSION_QUERY_CMD, {
      encoding: 'utf-8',
    });
    expect(execFileSync).not.toHaveBeenCalledWith(
      'sh',
      INSTALL_CALL,
      expect.anything(),
    );
    expect(execSync).not.toHaveBeenCalledWith(STOP_CMD, expect.anything());
    expect(printInfo).toHaveBeenCalledWith(
      expect.stringContaining('No local API server is running'),
    );
    // fetchLatestVersion resolves '9.9.9' by default, so the Homebrew-reported
    // CURRENT_VERSION is genuinely behind — both staleness messages should print.
    expect(printInfo).toHaveBeenCalledWith(
      expect.stringContaining(
        `Homebrew has anycloud ${CURRENT_VERSION}, but the current anycloud release is 9.9.9`,
      ),
    );
    expect(printInfo).toHaveBeenCalledWith(
      expect.stringContaining(
        'Run `anycloud update` again after Homebrew makes 9.9.9 available',
      ),
    );
  });

  it('fails clearly when the installed Homebrew version cannot be determined', async () => {
    process.execPath = '/opt/homebrew/Cellar/anycloud/0.1.30/bin/anycloud';
    vi.mocked(isApiContainerRunning).mockReturnValue(false);
    vi.mocked(execSync).mockImplementation(() => Buffer.from(''));

    await runUpdateExpectingProcessExit();

    expect(execSync).toHaveBeenCalledWith(HOMEBREW_UPDATE_CMD, {
      stdio: 'inherit',
    });
    expect(printError).toHaveBeenCalledWith(
      expect.stringContaining(
        'could not determine the installed anycloud version',
      ),
    );
  });

  it('restarts a stale Homebrew-managed API when Homebrew leaves the installed CLI on the current version', async () => {
    process.execPath = '/opt/homebrew/Cellar/anycloud/0.1.30/bin/anycloud';
    vi.mocked(getVersionFromContainer).mockReturnValue('0.0.1');
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === HOMEBREW_VERSION_QUERY_CMD) {
        return `anycloud ${CURRENT_VERSION}`;
      }
      return Buffer.from('');
    });

    await runUpdate();

    expect(execSync).toHaveBeenCalledWith(HOMEBREW_UPDATE_CMD, {
      stdio: 'inherit',
    });
    expect(execSync).toHaveBeenCalledWith(`${BREW_OPT_BIN} api stop`, {
      stdio: 'inherit',
    });
    expect(execSync).toHaveBeenCalledWith(
      `${BREW_OPT_BIN} api start --port 8080 --version=${CURRENT_VERSION}`,
      {
        stdio: 'inherit',
      },
    );
    expect(printInfo).toHaveBeenCalledWith(
      expect.stringContaining(`match installed anycloud ${CURRENT_VERSION}`),
    );
  });

  it('restarts a Homebrew-managed API on the version Homebrew installed', async () => {
    process.execPath = '/opt/homebrew/Cellar/anycloud/0.1.30/bin/anycloud';
    vi.mocked(getVersionFromContainer).mockReturnValue(CURRENT_VERSION);
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === HOMEBREW_VERSION_QUERY_CMD) return 'anycloud 9.9.9\n';
      return Buffer.from('');
    });

    await runUpdate();

    expect(execSync).toHaveBeenCalledWith(
      `docker image inspect ${pkg.apiImage}:9.9.9`,
      { stdio: 'ignore' },
    );
    expect(execSync).toHaveBeenCalledWith(`${BREW_OPT_BIN} api stop`, {
      stdio: 'inherit',
    });
    expect(execSync).toHaveBeenCalledWith(
      `${BREW_OPT_BIN} api start --port 8080 --version=9.9.9`,
      {
        stdio: 'inherit',
      },
    );
    expect(printInfo).toHaveBeenCalledWith(
      expect.stringContaining('match installed anycloud 9.9.9'),
    );
  });

  it('refuses when the latest release resolves lower than the current CLI version', async () => {
    vi.mocked(fetchLatestVersion).mockResolvedValue('0.0.1');

    await runUpdateExpectingProcessExit();

    expect(printError).toHaveBeenCalledWith(
      expect.stringContaining('Refusing to downgrade'),
    );
    expect(execSync).not.toHaveBeenCalled();
  });

  it('fails before installing when the latest release cannot be resolved', async () => {
    vi.mocked(fetchLatestVersion).mockResolvedValue(null);

    await runUpdateExpectingProcessExit();

    expect(printError).toHaveBeenCalledWith(
      expect.stringContaining('Could not resolve the current anycloud release'),
    );
    expect(execSync).not.toHaveBeenCalled();
  });

  it('restarts a stale running API server when the CLI is already current', async () => {
    vi.mocked(fetchLatestVersion).mockResolvedValue(CURRENT_VERSION);
    vi.mocked(isApiContainerRunning).mockReturnValue(true);
    vi.mocked(getVersionFromContainer).mockReturnValue('0.0.1');

    await runUpdate();

    expect(execFileSync).not.toHaveBeenCalledWith(
      'sh',
      INSTALL_CALL,
      expect.anything(),
    );
    expect(execSync).toHaveBeenCalledWith(STOP_CMD, { stdio: 'inherit' });
    expect(execSync).toHaveBeenCalledWith(startCmd(CURRENT_VERSION), {
      stdio: 'inherit',
    });
  });

  it('updates the running binary in place, then restarts the API with it', async () => {
    process.execPath = '/opt/any cloud/bin/anycloud-darwin-arm64';

    await runUpdate();

    expect(execFileSync).toHaveBeenCalledWith(
      'sh',
      ['-c', INSTALL_SCRIPT, 'sh', '/opt/any cloud/bin', '9.9.9'],
      { stdio: 'inherit' },
    );
    expect(execSync).toHaveBeenCalledWith(
      "'/opt/any cloud/bin/anycloud-darwin-arm64' api start --port 8080 --version=9.9.9",
      { stdio: 'inherit' },
    );
  });

  it('does not restart the API when the install fails', async () => {
    vi.mocked(execFileSync).mockImplementation((file) => {
      if (file === 'sh') throw new Error('installer exited 1');
      return '';
    });

    await runUpdateExpectingProcessExit();

    expect(execSync).not.toHaveBeenCalledWith(STOP_CMD, expect.anything());
    expect(printError).toHaveBeenCalledWith(
      'Update failed: installer exited 1',
    );
  });

  it('refuses to replace the runtime of a development invocation', async () => {
    process.execPath = '/usr/bin/node';
    process.argv[1] = '/src/anycloud/dist/cli/index.js';

    await runUpdateExpectingProcessExit();

    expect(execFileSync).not.toHaveBeenCalledWith(
      'sh',
      INSTALL_CALL,
      expect.anything(),
    );
    expect(printError).toHaveBeenCalledWith(
      expect.stringContaining('Update the source checkout instead'),
    );
  });

  it('restarts a development invocation with its runtime, flags and script', async () => {
    process.execPath = '/usr/bin/node';
    process.execArgv = ['--import', 'tsx'];
    process.argv[1] = '/src/anycloud/dist/cli/index.js';
    vi.mocked(fetchLatestVersion).mockResolvedValue(CURRENT_VERSION);
    vi.mocked(getVersionFromContainer).mockReturnValue('0.0.1');

    await runUpdate();

    expect(execSync).toHaveBeenCalledWith(
      `'/usr/bin/node' '--import' 'tsx' '/src/anycloud/dist/cli/index.js' api start --port 8080 --version=${CURRENT_VERSION}`,
      { stdio: 'inherit' },
    );
  });

  it('does not restart a current running API server just because its Docker version label is missing', async () => {
    vi.mocked(fetchLatestVersion).mockResolvedValue(CURRENT_VERSION);
    vi.mocked(isApiContainerRunning).mockReturnValue(true);
    vi.mocked(getVersionFromContainer).mockReturnValue(null);
    mocks.checkApiVersion.mockResolvedValue({
      url: 'http://localhost:8080',
      cliVersion: CURRENT_VERSION,
      apiVersion: CURRENT_VERSION,
      compatible: true,
    });

    await runUpdate();

    expect(mocks.checkApiVersion).toHaveBeenCalledWith('http://localhost:8080');
    expect(execSync).not.toHaveBeenCalled();
    expect(printInfo).toHaveBeenCalledWith(
      expect.stringContaining('no restart needed'),
    );
  });

  it('restarts a running API server when the Docker version label is missing and /v1/version is unavailable', async () => {
    vi.mocked(fetchLatestVersion).mockResolvedValue(CURRENT_VERSION);
    vi.mocked(isApiContainerRunning).mockReturnValue(true);
    vi.mocked(getVersionFromContainer).mockReturnValue(null);
    mocks.checkApiVersion.mockResolvedValue({
      url: 'http://localhost:8080',
      cliVersion: CURRENT_VERSION,
      compatible: false,
      reason: 'could not read /v1/version',
    });

    await runUpdate();

    expect(execSync).toHaveBeenCalledWith(STOP_CMD, { stdio: 'inherit' });
    expect(execSync).toHaveBeenCalledWith(startCmd(CURRENT_VERSION), {
      stdio: 'inherit',
    });
  });

  it('prints recovery guidance when the new API server cannot start', async () => {
    vi.mocked(fetchLatestVersion).mockResolvedValue(CURRENT_VERSION);
    vi.mocked(isApiContainerRunning).mockReturnValue(true);
    vi.mocked(getVersionFromContainer).mockReturnValue('0.0.1');
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === startCmd(CURRENT_VERSION)) throw new Error('start failed');
      return Buffer.from('');
    });

    await runUpdateExpectingProcessExit();

    // A failed start can leave an unhealthy container running, so the guidance
    // must conditionally stop it before retrying. If no container is running,
    // the operator can proceed directly to the start command.
    expect(printError).toHaveBeenCalledWith(
      expect.stringContaining('If it is still running'),
    );
    expect(printError).toHaveBeenCalledWith(
      expect.stringContaining('anycloud api stop'),
    );
    expect(printError).toHaveBeenCalledWith(
      expect.stringContaining(startCmd(CURRENT_VERSION)),
    );
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('reports a still-starting API server as updated, not failed', async () => {
    vi.mocked(fetchLatestVersion).mockResolvedValue(CURRENT_VERSION);
    vi.mocked(isApiContainerRunning).mockReturnValue(true);
    vi.mocked(getVersionFromContainer).mockReturnValue('0.0.1');
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === startCmd(CURRENT_VERSION)) {
        throw Object.assign(new Error('start failed'), { status: 4 });
      }
      return Buffer.from('');
    });
    await runUpdateExpectingProcessExit(4);

    expect(printWarning).toHaveBeenCalledWith(
      expect.stringMatching(/^anycloud is updated\. .*still starting/),
    );
    expect(printError).not.toHaveBeenCalled();
  });

  it('prints stop-specific guidance when the old API server cannot be stopped', async () => {
    vi.mocked(fetchLatestVersion).mockResolvedValue(CURRENT_VERSION);
    vi.mocked(isApiContainerRunning).mockReturnValue(true);
    vi.mocked(getVersionFromContainer).mockReturnValue('0.0.1');
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === STOP_CMD) throw new Error('stop failed');
      return Buffer.from('');
    });

    await runUpdateExpectingProcessExit();

    expect(printError).toHaveBeenCalledWith(
      expect.stringContaining(
        'Could not stop the running local API server to replace it',
      ),
    );
    // The start must not be attempted when the stop failed and the old
    // container is likely still running.
    expect(execSync).not.toHaveBeenCalledWith(
      startCmd(CURRENT_VERSION),
      expect.anything(),
    );
  });

  it('does nothing when the CLI and running API are already current', async () => {
    vi.mocked(fetchLatestVersion).mockResolvedValue(CURRENT_VERSION);
    vi.mocked(isApiContainerRunning).mockReturnValue(true);
    vi.mocked(getVersionFromContainer).mockReturnValue(CURRENT_VERSION);

    await runUpdate();

    expect(execSync).not.toHaveBeenCalled();
    expect(printInfo).toHaveBeenCalledWith(
      expect.stringContaining('no restart needed'),
    );
  });

  it('does nothing when the CLI is current and no API server is running', async () => {
    vi.mocked(fetchLatestVersion).mockResolvedValue(CURRENT_VERSION);
    vi.mocked(isApiContainerRunning).mockReturnValue(false);

    await runUpdate();

    expect(getVersionFromContainer).not.toHaveBeenCalled();
    expect(execSync).not.toHaveBeenCalled();
    expect(printInfo).toHaveBeenCalledWith(
      expect.stringContaining('No local API server is running'),
    );
  });
});

describe('isHomebrewManagedPath', () => {
  it('detects Homebrew cellar paths', () => {
    expect(
      isHomebrewManagedPath(
        '/opt/homebrew/Cellar/anycloud/0.1.30/bin/anycloud',
      ),
    ).toBe(true);
    expect(
      isHomebrewManagedPath(
        '/home/linuxbrew/.linuxbrew/Cellar/anycloud/0.1.30/bin/anycloud',
      ),
    ).toBe(true);
  });

  it('detects Homebrew bin symlinks', () => {
    vi.spyOn(realpathSync, 'native').mockReturnValue(
      '/usr/local/Cellar/anycloud/0.1.30/bin/anycloud',
    );

    expect(isHomebrewManagedPath('/usr/local/bin/anycloud')).toBe(true);
  });

  it('does not flag standalone install paths', () => {
    vi.spyOn(realpathSync, 'native').mockImplementation((path) =>
      path.toString(),
    );

    expect(isHomebrewManagedPath('/usr/local/bin/anycloud')).toBe(false);
    expect(isHomebrewManagedPath('/home/user/.local/bin/anycloud')).toBe(false);
  });
});
