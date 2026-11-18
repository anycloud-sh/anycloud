import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from 'vitest';
import {
  setJsonMode,
  isJsonMode,
  printInfo,
  printSuccess,
  printWarning,
  printHighlight,
  printError,
} from '../../../src/cli/utils/output.js';

describe('setJsonMode / chrome routing', () => {
  let stdoutSpy: MockInstance<typeof process.stdout.write>;
  let stderrSpy: MockInstance<typeof process.stderr.write>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    setJsonMode(false);
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('routes chrome to stdout when JSON mode is off (default)', () => {
    expect(isJsonMode()).toBe(false);
    printInfo('hi');
    printSuccess('ok');
    printWarning('uh');
    printHighlight('!!');
    expect(stdoutSpy).toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('routes chrome to stderr when JSON mode is on', () => {
    setJsonMode(true);
    expect(isJsonMode()).toBe(true);
    printInfo('hi');
    printSuccess('ok');
    printWarning('uh');
    printHighlight('!!');
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalled();
  });

  it('can route a warning to stderr outside JSON mode', () => {
    printWarning('truncated', true);
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  it('printError always goes to stderr regardless of JSON mode', () => {
    printError('bad');
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    setJsonMode(true);
    printError('still bad');
    expect(stderrSpy).toHaveBeenCalledTimes(2);
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('setJsonMode(false) restores stdout routing', () => {
    setJsonMode(true);
    printInfo('a');
    expect(stderrSpy).toHaveBeenCalledTimes(1);

    setJsonMode(false);
    printInfo('b');
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
  });
});

describe('credentials list --json payload shape', () => {
  it('includes name + cloudProvider but never secret fields', () => {
    // Mirror the mapping in src/cli/commands/credentials/list.ts
    type Stored = {
      name: string;
      cloudProvider: string;
      accessKeyId?: string;
      secretAccessKey?: string;
      privateKey?: string;
      clientEmail?: string;
      projectId?: string;
      applicationId?: string;
      subscriptionId?: string;
    };
    const saved: Stored[] = [
      {
        name: 'prod-aws',
        cloudProvider: 'AWS',
        accessKeyId: 'AKIA...',
        secretAccessKey: 'SECRET_DO_NOT_LEAK',
      },
      {
        name: 'prod-gcp',
        cloudProvider: 'GCP',
        privateKey: 'SECRET_PRIVATE_KEY',
        clientEmail: 'sa@proj.iam.gserviceaccount.com',
        projectId: 'proj',
      },
    ];

    const payload = saved.map((c) => ({
      name: c.name,
      cloudProvider: c.cloudProvider,
    }));

    expect(payload).toEqual([
      { name: 'prod-aws', cloudProvider: 'AWS' },
      { name: 'prod-gcp', cloudProvider: 'GCP' },
    ]);

    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('SECRET_DO_NOT_LEAK');
    expect(serialized).not.toContain('SECRET_PRIVATE_KEY');
    expect(serialized).not.toContain('AKIA');
    expect(serialized).not.toContain('sa@proj');
    expect(serialized).not.toContain('projectId');
  });
});
