import { describe, expect, it } from 'vitest';
import packageJson from '../../../package.json' with { type: 'json' };
import {
  hostedApiOwnerFromArgv,
  isHostedApiWorkload,
  isHostedApiImage,
} from '../../../src/shared/hosted-api';
import { WorkloadType } from '../../../src/shared/workload.js';

describe('hosted API helpers', () => {
  it('recognizes the AnyCloud API image by bare name, tag, or digest', () => {
    expect(isHostedApiImage(packageJson.apiImage)).toBe(true);
    expect(isHostedApiImage(`${packageJson.apiImage}:0.1.32`)).toBe(true);
    expect(
      isHostedApiImage(`${packageJson.apiImage}@sha256:${'a'.repeat(64)}`),
    ).toBe(true);
  });

  it('does not recognize other images', () => {
    expect(isHostedApiImage('ghcr.io/anycloud-sh/api-tools:latest')).toBe(
      false,
    );
    expect(isHostedApiImage('nginx:alpine')).toBe(false);
  });

  it('recognizes only a Service using the hosted API image', () => {
    const image = `${packageJson.apiImage}:0.1.32`;
    expect(
      isHostedApiWorkload({
        workloadType: WorkloadType.Service,
        image,
      }),
    ).toBe(true);
    expect(
      isHostedApiWorkload({
        workloadType: WorkloadType.Job,
        image,
      }),
    ).toBe(false);
  });

  it('parses a complete hosted owner identity in either argument order', () => {
    expect(
      hostedApiOwnerFromArgv([
        '--hosted-api-owner-id',
        '583231',
        '--hosted-api-owner',
        'octocat',
      ]),
    ).toEqual({
      ownerUserId: '583231',
      username: 'octocat',
      githubAppIds: [],
    });
  });

  it('parses the GitHub Apps whose user tokens the API exchanges', () => {
    const owner = [
      '--hosted-api-owner',
      'octocat',
      '--hosted-api-owner-id',
      '1',
    ];
    expect(
      hostedApiOwnerFromArgv([
        ...owner,
        '--hosted-api-github-apps',
        '5622376,7',
      ]),
    ).toMatchObject({ githubAppIds: [5622376, 7] });
    expect(hostedApiOwnerFromArgv(owner)).toMatchObject({ githubAppIds: [] });
    expect(() =>
      hostedApiOwnerFromArgv([
        ...owner,
        '--hosted-api-github-apps',
        'backmesh',
      ]),
    ).toThrow('GitHub App ids');
  });

  it('rejects username-only hosted commands', () => {
    expect(() =>
      hostedApiOwnerFromArgv(['--hosted-api-owner', 'octocat']),
    ).toThrow('must be provided together');
  });

  it('rejects id-only hosted commands', () => {
    expect(() =>
      hostedApiOwnerFromArgv(['--hosted-api-owner-id', '583231']),
    ).toThrow('must be provided together');
  });

  it('rejects malformed user ids', () => {
    expect(() =>
      hostedApiOwnerFromArgv([
        '--hosted-api-owner',
        'octocat',
        '--hosted-api-owner-id',
        'not-an-id',
      ]),
    ).toThrow('positive integer');
  });
});
