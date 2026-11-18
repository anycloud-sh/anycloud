import { describe, expect, it } from 'vitest';
import {
  clientWindowVersionCheck,
  releaseWindowVersionCheck,
  versionCheck,
} from '../../../src/api/services/api-version.js';
import config from '../../../src/api/config.js';
import { ApiVersionMismatchError } from '../../../src/shared/errors.js';

describe('client version checks', () => {
  const served = config.currVersion.split('.').map(Number);
  const at = (major: number, minor: number, patch: number) =>
    `${major}.${minor}.${patch}`;
  const newer = at(served[0], served[1], served[2] + 7);
  const olderThanPrevious = at(served[0], served[1], served[2] - 2);

  it('requires an exact match for ordinary procedures', () => {
    expect(() => versionCheck(config.currVersion)).not.toThrow();
    for (const bad of [config.previousVersion, newer]) {
      expect(() => versionCheck(bad)).toThrow(ApiVersionMismatchError);
    }
  });

  it('admits the current and previous release to the client window, and nothing else', () => {
    for (const ok of [config.currVersion, config.previousVersion]) {
      expect(() => clientWindowVersionCheck(ok)).not.toThrow();
    }
    for (const bad of [undefined, olderThanPrevious, newer]) {
      expect(() => clientWindowVersionCheck(bad)).toThrow(
        ApiVersionMismatchError,
      );
    }
  });

  it('refuses a missing header even when no predecessor is recorded', () => {
    const recorded = config.previousVersion;
    Object.assign(config, { previousVersion: undefined });
    try {
      expect(() => clientWindowVersionCheck(undefined)).toThrow(
        ApiVersionMismatchError,
      );
      expect(() => releaseWindowVersionCheck(undefined)).toThrow(
        ApiVersionMismatchError,
      );
    } finally {
      Object.assign(config, { previousVersion: recorded });
    }
  });

  it('also lets a newer CLI of the same major line upgrade the API', () => {
    for (const ok of [
      config.currVersion,
      config.previousVersion,
      newer,
      at(served[0], served[1] + 1, 0),
    ]) {
      expect(() => releaseWindowVersionCheck(ok)).not.toThrow();
    }
    for (const bad of [
      undefined,
      'not-a-version',
      olderThanPrevious,
      at(served[0] + 1, 0, 0),
    ]) {
      expect(() => releaseWindowVersionCheck(bad)).toThrow(
        ApiVersionMismatchError,
      );
    }
  });
});
