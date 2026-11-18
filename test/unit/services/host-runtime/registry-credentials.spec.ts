import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ImageDeliveryHost,
  pullImage,
} from '../../../../src/api/services/host-runtime/image-delivery';
import { makeStoredWorkload } from '../../helpers/fixtures';

const run = promisify(execFile);
const TOKEN = 'ghp_member_secret_token';
// A login that earlier releases left in root's Docker config.
const LEGACY = 'ghp_login_left_by_an_earlier_release';

// Docker's config lookup: `--config`, then `DOCKER_CONFIG`, then `~/.docker`.
// Login records the registry's credential there, logout drops that entry, and
// a private GHCR pull fails unless the config holds a ghcr.io login.
const FAKE_DOCKER = `#!/bin/sh
cfg="\${DOCKER_CONFIG:-$HOME/.docker}"
if [ "$1" = --config ]; then cfg=$2; shift 2; fi
case "$1" in
  login) mkdir -p "$cfg" && printf '{"auths":{"%s":{"auth":"%s"}}}\\n' "$2" "$(cat)" > "$cfg/config.json" ;;
  logout) grep -v "$2" "$cfg/config.json" > "$cfg/kept" 2>/dev/null; mv "$cfg/kept" "$cfg/config.json" 2>/dev/null ;;
  pull) grep -q '"ghcr.io"' "$cfg/config.json" 2>/dev/null || { echo unauthorized >&2; exit 1; } ;;
esac
`;

async function filesContaining(dir: string, text: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const hits: string[] = [];
  for (const entry of entries.filter((e) => e.isFile())) {
    const path = join(entry.parentPath, entry.name);
    if ((await readFile(path, 'utf8')).includes(text)) hits.push(path);
  }
  return hits;
}

describe('registry credentials on a VM host', () => {
  let root: string;
  let savedIsTest: string | undefined;

  beforeEach(async () => {
    savedIsTest = process.env.IS_TEST;
    delete process.env.IS_TEST; // the real private-registry path
    root = await mkdtemp(join(tmpdir(), 'ac-registry-creds-'));
    await mkdir(join(root, 'bin'));
    await mkdir(join(root, 'home', '.docker'), { recursive: true });
    await writeFile(
      join(root, 'home', '.docker', 'config.json'),
      `{"auths":{\n"ghcr.io":{"auth":"${LEGACY}"}\n}}\n`,
    );
    await mkdir(join(root, 'tmp'));
    await writeFile(join(root, 'bin', 'docker'), FAKE_DOCKER);
    await writeFile(join(root, 'bin', 'ps'), '#!/bin/sh\n'); // no systemd
    await chmod(join(root, 'bin', 'docker'), 0o755);
    await chmod(join(root, 'bin', 'ps'), 0o755);
  });
  afterEach(async () => {
    if (savedIsTest === undefined) delete process.env.IS_TEST;
    else process.env.IS_TEST = savedIsTest;
    await rm(root, { recursive: true, force: true });
  });

  // Runs each command in a real shell, with the VM's root-owned paths
  // relocated under the sandbox. Like DockerManager, `exec` throws on a
  // nonzero exit and `execResult` returns it.
  function vmHost(isLocal: boolean): ImageDeliveryHost {
    const execResult = async (cmd: string) => {
      const script = cmd
        .replaceAll('/run/anycloud', join(root, 'run'))
        .replaceAll('/tmp/', `${join(root, 'tmp')}/`);
      try {
        const { stdout, stderr } = await run('sh', ['-c', script], {
          env: {
            ...process.env,
            HOME: join(root, 'home'),
            PATH: `${join(root, 'bin')}:${process.env.PATH}`,
          },
        });
        return { code: 0, stdout, stderr };
      } catch (error) {
        const e = error as { code: number; stdout: string; stderr: string };
        return { code: e.code, stdout: e.stdout, stderr: e.stderr };
      }
    };
    const exec = async (cmd: string) => {
      const result = await execResult(cmd);
      if (result.code !== 0) throw new Error(`exit ${result.code}`);
      return result;
    };
    return { host: 'vm.test', isLocal, exec, execResult };
  }

  it.each([
    ['a remote VM', false],
    ['the local host', true],
  ])(
    'leaves no GHCR credential on %s after a private pull',
    async (_, isLocal) => {
      await expect(
        pullImage(
          vmHost(isLocal),
          makeStoredWorkload({
            id: `creds-${isLocal}`,
            image: 'ghcr.io/anycloud-sh/private:latest',
            githubToken: TOKEN,
            userId: 'octocat',
          }),
        ),
      ).resolves.toMatchObject({ outcome: 'succeeded' });

      expect(await filesContaining(root, TOKEN)).toEqual([]);
      expect(await filesContaining(root, LEGACY)).toEqual([]);
    },
  );
});
