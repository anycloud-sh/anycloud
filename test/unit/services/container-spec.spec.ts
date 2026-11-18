import { describe, expect, it } from 'vitest';
import {
  decodeContainerSpec,
  encodeContainerSpec,
  type ContainerSpec,
} from '../../../src/api/services/container-spec.js';
import { encryptSecret } from '../../../src/api/services/secret-crypto.js';

const original: ContainerSpec = {
  image: 'example/workload:latest',
  imageDigest: 'sha256:stored-digest',
  command: ['sh', '-c', 'echo ready'],
  dockerOptions: { shmSize: '2g', binds: ['/data:/data'] },
  env: { 'legacy.name': 'environment-canary', EMPTY: '' },
  registryUsername: 'registry-user-canary',
  registryToken: 'registry-token-canary',
};

describe('private container spec codec', () => {
  it('0036/S13 0036/S22 preserves stored values and encrypts each sensitive field independently', async () => {
    const first = await encodeContainerSpec(original);
    const second = await encodeContainerSpec(original);

    expect(await decodeContainerSpec(first)).toEqual(original);
    expect(await decodeContainerSpec(second)).toEqual(original);
    for (const field of [
      'env',
      'registry_username',
      'registry_token',
    ] as const) {
      expect(first[field]).not.toEqual(second[field]);
    }
    expect(JSON.stringify(first)).not.toContain('environment-canary');
    expect(JSON.stringify(first)).not.toContain('registry-user-canary');
    expect(JSON.stringify(first)).not.toContain('registry-token-canary');
    expect(first.image).toBe(original.image);
    expect(first.command).toBe(JSON.stringify(original.command));
    expect(first.docker_options).toBe(JSON.stringify(original.dockerOptions));
  });

  it.each([null, {}])(
    '0036/S18 preserves null versus empty environment: %j',
    async (env) => {
      const spec = { ...original, env };
      expect(
        await decodeContainerSpec(await encodeContainerSpec(spec)),
      ).toEqual(spec);
    },
  );

  it('0036/S18 preserves explicit empty username, token, command and options', async () => {
    const spec = {
      ...original,
      registryUsername: '',
      registryToken: '',
      command: [],
      dockerOptions: {},
    };
    expect(await decodeContainerSpec(await encodeContainerSpec(spec))).toEqual(
      spec,
    );
  });

  it.each([
    ['image', ''],
    ['imageDigest', 3],
    ['command', ['valid', 3]],
    ['env', { SECRET: 3 }],
    ['dockerOptions', { binds: [3] }],
    ['registryUsername', null],
    ['registryToken', {}],
  ])(
    '0036/S13 rejects malformed %s without echoing values',
    async (field, value) => {
      const malformed = { ...original, [field]: value };
      await expect(
        encodeContainerSpec(
          malformed as ContainerSpec,
          'Deployment deployment-1',
        ),
      ).rejects.toThrow(`Deployment deployment-1: invalid ${field}`);
    },
  );

  it.each([
    ['command', '{secret-canary'],
    ['command', '["secret-canary",3]'],
    ['docker_options', '["secret-canary"]'],
    ['env', 'secret-canary'],
    ['registry_username', 'secret-canary'],
    ['registry_token', 'secret-canary'],
  ] as const)(
    '0036/S13 rejects malformed stored %s with safe owner/field context',
    async (field, value) => {
      const stored = {
        ...(await encodeContainerSpec(original)),
        [field]: value,
      };
      const error = await decodeContainerSpec(
        stored,
        'Deployment deployment-1',
      ).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        'Deployment deployment-1: invalid ',
      );
      expect((error as Error).message).not.toContain('secret-canary');
    },
  );

  it('0036/S13 validates decrypted environment representation, not just its ciphertext', async () => {
    const stored = await encodeContainerSpec(original);
    stored.env = await encryptSecret(
      JSON.stringify({ SECRET: ['secret-canary'] }),
    );
    await expect(
      decodeContainerSpec(stored, 'Deployment deployment-1'),
    ).rejects.toThrow('Deployment deployment-1: invalid env');
  });
});
