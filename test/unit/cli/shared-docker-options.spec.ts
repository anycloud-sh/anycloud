import { describe, expect, it } from 'vitest';
import { buildDockerOptions } from '../../../src/cli/commands/shared';
import { validateDockerOptionsRequest } from '../../../src/shared/docker-options.js';

describe('buildDockerOptions', () => {
  it('omits Docker options for absent flags and Commander default empty arrays', () => {
    expect(buildDockerOptions({ gpus: undefined })).toBeUndefined();
    expect(buildDockerOptions({ ulimit: [], bind: [] })).toBeUndefined();
  });

  it.each(
    ['gpus', 'runtime', 'shmSize', 'memory', 'cpus', 'ipc', 'network'].flatMap(
      (field) => [
        { field, otherOptions: {} },
        { field, otherOptions: { memory: '1g', shmSize: '1g' } },
      ],
    ),
  )(
    'preserves explicitly empty $field for API validation with $otherOptions',
    ({ field, otherOptions }) => {
      const input = { ...otherOptions, [field]: '' };
      const options = JSON.parse(JSON.stringify(buildDockerOptions(input)));

      expect(options).toEqual(input);
      expect(() => validateDockerOptionsRequest(options)).toThrow(
        `dockerOptions.${field} must be a non-empty string.`,
      );
    },
  );

  it('preserves explicitly configured repeatable options', () => {
    expect(
      buildDockerOptions({
        ulimit: ['nofile=2048:2048'],
        bind: ['/tmp/data:/data'],
      }),
    ).toMatchObject({
      ulimits: ['nofile=2048:2048'],
      binds: ['/tmp/data:/data'],
    });
  });
});
