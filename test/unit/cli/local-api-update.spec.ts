import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('../../../src/shared/services/api-client/runtime.js', () => ({
  checkApiVersion: vi.fn(),
}));

vi.mock('../../../src/cli/utils/output.js', () => ({
  isJsonMode: vi.fn(() => false),
  printInfo: vi.fn(),
  printWarning: vi.fn(),
}));

import { execFileSync, execSync } from 'child_process';
import {
  getLocalApiContainerHostPort,
  getLocalApiContainerVersion,
  isLocalApiContainerRunning,
} from '../../../src/shared/local-api-container.js';
import { reconcileLocalApi } from '../../../src/cli/services/local-api-update.js';
import { isJsonMode, printInfo } from '../../../src/cli/utils/output.js';
import packageJson from '../../../package.json' with { type: 'json' };

const BIN = '/home/user/.local/bin/anycloud';

describe('local API reconciliation service', () => {
  const originalExecPath = process.execPath;
  const originalArgvOne = process.argv[1];

  beforeEach(() => {
    vi.clearAllMocks();
    process.execPath = BIN;
    process.argv[1] = '/$bunfs/root/anycloud';
    vi.mocked(execFileSync).mockReturnValue('');
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));
    vi.mocked(isLocalApiContainerRunning).mockReturnValue(false);
    vi.mocked(getLocalApiContainerHostPort).mockReturnValue(null);
    vi.mocked(getLocalApiContainerVersion).mockReturnValue(null);
  });

  afterEach(() => {
    process.execPath = originalExecPath;
    process.argv[1] = originalArgvOne;
  });

  it('starts the API with the Homebrew opt link, which survives the upgrade', async () => {
    process.execPath = '/opt/homebrew/Cellar/anycloud/0.1.30/bin/anycloud';

    await reconcileLocalApi(packageJson.version, { startIfStopped: true });

    expect(execSync).toHaveBeenCalledWith(
      `'/opt/homebrew/opt/anycloud/bin/anycloud' api start --version=${packageJson.version}`,
      { stdio: 'inherit' },
    );
  });

  it('starts a stopped local API when reconciliation requests it', async () => {
    await reconcileLocalApi(packageJson.version, { startIfStopped: true });

    expect(execSync).toHaveBeenCalledWith(
      `docker image inspect ${packageJson.apiImage}:${packageJson.version}`,
      { stdio: 'ignore' },
    );
    expect(execSync).toHaveBeenCalledWith(
      `'${BIN}' api start --version=${packageJson.version}`,
      { stdio: 'inherit' },
    );
    expect(execSync).not.toHaveBeenCalledWith(
      `'${BIN}' api stop`,
      expect.anything(),
    );
  });

  it("sends the restart commands' output to stderr under --json, so stdout stays one document", async () => {
    vi.mocked(isLocalApiContainerRunning).mockReturnValue(true);
    vi.mocked(getLocalApiContainerVersion).mockReturnValue('0.0.1');
    vi.mocked(isJsonMode).mockReturnValue(true);
    await reconcileLocalApi(packageJson.version, { startIfStopped: true });
    vi.mocked(isJsonMode).mockReturnValue(false);
    expect(execSync).toHaveBeenCalledWith(`'${BIN}' api stop`, {
      stdio: ['inherit', 2, 'inherit'],
    });
    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining(`'${BIN}' api start`),
      { stdio: ['inherit', 2, 'inherit'] },
    );
  });

  it('starts a stopped local API on the requested active loopback port', async () => {
    await reconcileLocalApi(packageJson.version, {
      startIfStopped: true,
      startPort: 9000,
    });

    expect(execSync).toHaveBeenCalledWith(
      `'${BIN}' api start --port 9000 --version=${packageJson.version}`,
      { stdio: 'inherit' },
    );
    expect(execSync).not.toHaveBeenCalledWith(
      `'${BIN}' api stop`,
      expect.anything(),
    );
  });

  it('preserves root update behavior by leaving a stopped API stopped by default', async () => {
    await reconcileLocalApi(packageJson.version);

    expect(execSync).not.toHaveBeenCalled();
    expect(printInfo).toHaveBeenCalledWith(
      'No local API server is running, so there is nothing to restart.',
    );
  });

  const STILL_STARTING = /^(?!.*api stop).*still starting.*docker logs/s;
  it.each([
    ['a restart', true, 4, STILL_STARTING],
    [
      'a restart',
      true,
      1,
      /did not start cleanly\. If it is still running, run `anycloud api stop`/,
    ],
    ['a start', false, 4, STILL_STARTING],
    ['a start', false, 1, /Could not start the local API server/],
  ])(
    'maps an api start exit during %s (running %s, exit %i) to its message',
    async (_path, running, status, message) => {
      vi.mocked(isLocalApiContainerRunning).mockReturnValue(running);
      vi.mocked(getLocalApiContainerVersion).mockReturnValue('0.0.1');
      vi.mocked(execSync).mockImplementation((command) => {
        if (String(command).includes('api start')) {
          throw Object.assign(new Error('start failed'), { status });
        }
        return Buffer.from('');
      });

      await expect(
        reconcileLocalApi(packageJson.version, { startIfStopped: true }),
      ).rejects.toThrow(message);
    },
  );
});
