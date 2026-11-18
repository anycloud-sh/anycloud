import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from 'vitest';
import { PassThrough } from 'stream';
import { pipeline } from 'stream/promises';
import { withByteProgress } from '../../../src/cli/utils/byte-progress.js';

describe('withByteProgress', () => {
  const originalIsTTY = process.stderr.isTTY;
  let stderrSpy: MockInstance<typeof process.stderr.write>;

  beforeEach(() => {
    Object.defineProperty(process.stderr, 'isTTY', {
      value: true,
      configurable: true,
    });
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    Object.defineProperty(process.stderr, 'isTTY', {
      value: originalIsTTY,
      configurable: true,
    });
    stderrSpy.mockRestore();
  });

  it('propagates source errors to the wrapped stream', async () => {
    const source = new PassThrough();
    const wrapped = withByteProgress(source, 'test');
    const sink = new PassThrough();

    const pipelinePromise = pipeline(wrapped, sink);
    source.destroy(new Error('boom'));

    await expect(pipelinePromise).rejects.toThrow(/boom/);
  });

  it('returns the source unchanged when stderr is not a TTY', () => {
    Object.defineProperty(process.stderr, 'isTTY', {
      value: false,
      configurable: true,
    });
    const source = new PassThrough();
    expect(withByteProgress(source, 'test')).toBe(source);
  });
});
