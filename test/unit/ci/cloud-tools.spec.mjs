import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(
  new URL('../../../ci/check-cloud-tools.sh', import.meta.url),
);
const tools = ['aws', 'az', 'gcloud'];
const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function check({ missing, broken } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-tools-'));
  directories.push(directory);
  const calls = join(directory, 'calls');
  for (const tool of tools) {
    if (tool === missing) continue;
    writeFileSync(
      join(directory, tool),
      `#!/bin/sh\nprintf '%s\\n' "${tool} $*" >> "$CLOUD_TOOL_CALLS"\nexit ${tool === broken ? 7 : 0}\n`,
      { mode: 0o755 },
    );
  }
  const result = spawnSync('/bin/bash', [script], {
    env: { PATH: directory, CLOUD_TOOL_CALLS: calls },
    encoding: 'utf8',
    timeout: 5_000,
  });
  return {
    ...result,
    calls: existsSync(calls)
      ? readFileSync(calls, 'utf8').trim().split('\n')
      : [],
  };
}

describe('CI cloud toolchain prerequisite', () => {
  it('checks the installed tools without authenticating or installing anything', () => {
    const result = check();
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([
      'aws --version',
      'az version --output none',
      'gcloud --version',
    ]);
  });

  it.each(tools)(
    'fails before invoking tools when %s is missing',
    (missing) => {
      const result = check({ missing });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`CI runner is missing ${missing}`);
      expect(result.calls).toEqual([]);
    },
  );

  it.each(tools)('rejects a broken %s installation', (broken) => {
    const result = check({ broken });
    expect(result.status).toBe(7);
    expect(result.calls.at(-1).split(' ')[0]).toBe(broken);
  });
});
