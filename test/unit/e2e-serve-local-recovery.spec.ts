import { describe, expect, test } from 'vitest';

import {
  adoptionUnmet,
  servingUnmet,
  type StartingCheckpoint,
} from '../integration/e2e/internal/contracts/serve-local-recovery.js';
import {
  dnsUnmet,
  serveTargetClass,
} from '../integration/e2e/internal/contracts/serve.js';
import type { LocalSmolvmServeReadyObservation } from '../integration/e2e/internal/targets/serve-types.js';
import { LocalSmolvmServeTransport } from '../integration/e2e/internal/transports/local-smolvm-serve.js';

const MARKERS = ['marker-v1', 'secret-ok'];

const CHECKPOINT: StartingCheckpoint = {
  guestContainerId: 'sha256:container-one',
  httpHostPort: 20080,
  machineName: 'ac-local-d-lsrv-0',
  sshHostPort: 20022,
};

function observation(
  overrides: Partial<LocalSmolvmServeReadyObservation> = {},
): LocalSmolvmServeReadyObservation {
  return {
    kind: 'local-smolvm',
    guestContainerId: CHECKPOINT.guestContainerId,
    httpHostPort: CHECKPOINT.httpHostPort,
    machineCount: 1,
    machineName: CHECKPOINT.machineName,
    machineState: 'running',
    responseBody: MARKERS.join('\n'),
    sshHostPort: CHECKPOINT.sshHostPort,
    ...overrides,
  };
}

describe('Local Serve starting checkpoint', () => {
  test('accepts a microVM that is already answering with every marker', () => {
    expect(servingUnmet(observation(), MARKERS)).toBeUndefined();
  });

  test('waits when the substrate has not been observed at all', () => {
    expect(servingUnmet(undefined, MARKERS)).toBe('no Local observation yet');
  });

  test('waits while the guest workload container does not exist yet', () => {
    expect(servingUnmet(observation({ guestContainerId: '' }), MARKERS)).toBe(
      'guest workload container is absent',
    );
  });

  test('names each marker the response is still missing', () => {
    expect(
      servingUnmet(observation({ responseBody: 'marker-v1' }), MARKERS),
    ).toBe('workload is not yet answering with secret-ok');
  });

  test('refuses a single host port serving both guest ports', () => {
    expect(
      servingUnmet(observation({ httpHostPort: CHECKPOINT.sshHostPort }), [
        ...MARKERS,
      ]),
    ).toBe('microVM forwarded one host port for both guest ports');
  });

  test('refuses more than one owned microVM', () => {
    expect(servingUnmet(observation({ machineCount: 2 }), MARKERS)).toBe(
      'expected exactly one owned microVM, saw 2',
    );
  });
});

describe('Local Serve recovery adoption', () => {
  test('accepts the same microVM, ports, and guest container', () => {
    expect(adoptionUnmet(CHECKPOINT, observation())).toBeUndefined();
  });

  test('rejects a replacement microVM', () => {
    expect(
      adoptionUnmet(
        CHECKPOINT,
        observation({ machineName: 'ac-local-d-lsrv-1' }),
      ),
    ).toContain('replaced the microVM');
  });

  test('rejects a changed forwarded port even when the microVM is the same', () => {
    expect(
      adoptionUnmet(CHECKPOINT, observation({ httpHostPort: 20081 })),
    ).toContain('changed the forwarded host ports');
  });

  test('rejects a restarted guest workload container', () => {
    expect(
      adoptionUnmet(
        CHECKPOINT,
        observation({ guestContainerId: 'sha256:container-two' }),
      ),
    ).toContain('replaced the guest workload container');
  });

  test('rejects an observation from a different substrate', () => {
    expect(
      adoptionUnmet(CHECKPOINT, {
        kind: 'public-cloud',
        provider: 'aws',
        responseBody: '',
        statusCode: 200,
        url: 'https://d-other.anycloud.sh',
      }),
    ).toContain('did not report a Local observation');
  });
});

describe('Serve DNS publication', () => {
  test('requires a record from a class that publishes one', () => {
    expect(
      dnsUnmet(
        null,
        serveTargetClass({ kind: 'public-cloud', provider: 'aws' }),
      ),
    ).toContain('did not persist a DNS record');
    expect(
      dnsUnmet(
        'dns-1',
        serveTargetClass({ kind: 'public-cloud', provider: 'aws' }),
      ),
    ).toBeUndefined();
  });

  test('rejects a record from a class that publishes none', () => {
    expect(
      dnsUnmet('dns-1', serveTargetClass({ kind: 'local-smolvm' })),
    ).toContain('publishes no DNS');
    expect(
      dnsUnmet(null, serveTargetClass({ kind: 'local-smolvm' })),
    ).toBeUndefined();
  });
});

describe('Local Service forwarded-port cleanup', () => {
  test.each([
    {
      failure: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }),
      absent: true,
    },
    {
      failure: new Error('request failed', {
        cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }),
      }),
      absent: true,
    },
    { failure: new Error('cleanup cancelled'), absent: false },
    {
      failure: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }),
      absent: false,
    },
    { failure: new Error('artifact write failed'), absent: false },
  ])(
    'requires explicit connection refusal: $failure.message',
    async ({ failure, absent }) => {
      const deadlineAt = Date.now() + 1_000;
      const transport = new LocalSmolvmServeTransport(
        { json: async () => '/tmp/ports.json' },
        {
          get: async (label, _url, options) => {
            expect(options?.deadlineAt).toBe(deadlineAt);
            if (label === 'local-smolvm-machines')
              return { body: [], status: 200 };
            throw failure;
          },
          post: async () => {
            throw new Error('unexpected post');
          },
        },
      );
      const observation = transport.observeAbsent(
        'service-one',
        [],
        [20022, 20080],
        deadlineAt,
      );
      if (absent)
        await expect(observation).resolves.toMatchObject({
          openForwardedPorts: [],
        });
      else await expect(observation).rejects.toBe(failure);
    },
  );
});
