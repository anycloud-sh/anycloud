import {
  AssumeRoleWithWebIdentityCommand,
  GetCallerIdentityCommand,
  IDPCommunicationErrorException,
  InvalidIdentityTokenException,
  STSClient,
  STSServiceException,
} from '@aws-sdk/client-sts';
import { IdentityPoolClient } from 'google-auth-library';
import nock from 'nock';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  RoleConnectionCheckError,
  RoleConnectionPendingError,
} from '../../../src/api/services/credentials-domain.js';
import {
  createRoleConnectionCheck,
  TRUST_PROBE_AUDIENCE,
} from '../../../src/api/services/role-connection-check.js';
import { CloudType } from '../../../src/shared/cloud.js';

const ISSUER = 'https://issuer.example.com/cluster';
const SUBJECT = 'system:serviceaccount:anycloud-system:anycloud-api';
const PROBE_SUBJECT =
  'system:serviceaccount:anycloud-system:anycloud-trust-probe';
const PROVIDER =
  'projects/123456789/locations/global/workloadIdentityPools/anycloud/providers/cluster';

function serviceAccountToken(audience: string, subject = SUBJECT): string {
  const part = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'RS256' })}.${part({ iss: ISSUER, sub: subject, aud: [audience] })}.signature`;
}

function claims(token: string): { sub: string; aud: string[] } {
  return JSON.parse(
    Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'),
  ) as { sub: string; aud: string[] };
}

/**
 * Which tokens a cloud's trust admits: a pinned one only the API's subject
 * for the connection's audience; an unpinned one any subject, or any audience.
 */
type Trust = 'pinned' | 'any subject' | 'any audience';

function admits(trust: Trust, token: string, audience: string): boolean {
  const { sub, aud } = claims(token);
  return (
    (trust === 'any subject' || sub === SUBJECT) &&
    (trust === 'any audience' || aud.includes(audience))
  );
}

function check() {
  const audiences: string[] = [];
  const run = createRoleConnectionCheck({
    tokens: async (audience) => {
      audiences.push(audience);
      return serviceAccountToken(audience);
    },
    probeTokens: async (audience) =>
      serviceAccountToken(audience, PROBE_SUBJECT),
  });
  return { run, audiences };
}

/** The refusal or pending error a save ends with. */
async function failure(run: Promise<unknown>): Promise<Error> {
  return (await run.then(
    () => {
      throw new Error('the save succeeded');
    },
    (error: unknown) => error,
  )) as Error;
}

/**
 * A probe that ends in anything but the cloud's refusal proves nothing: the
 * save is neither refused nor stored, and asks to be repeated.
 */
async function expectProbeRetried(
  run: Promise<unknown>,
  connection: string,
  claim: 'subject' | 'audience' = 'subject',
) {
  const pending = await failure(run);
  expect(pending).toBeInstanceOf(RoleConnectionPendingError);
  expect(pending.message).toContain(
    `Could not finish checking that the trust of ${connection} pins its ${claim}; trying again.`,
  );
}

const unpinned = [
  ['subject', 'any subject', PROBE_SUBJECT],
  ['audience', 'any audience', TRUST_PROBE_AUDIENCE],
] as const;

/**
 * STS's answer to a token it will not validate: one whose audience is not
 * among the OIDC provider's client IDs, an unregistered issuer, or a forged
 * signature (spike run 41602934504).
 */
const STS_INVALID_TOKEN =
  'The web identity token provided could not be validated. See the AssumeRoleWithWebIdentity documentation for requirements.';

/** An STS error the SDK has no class for. */
function stsError(name: string, message: string, status: number) {
  return new STSServiceException({
    name,
    message,
    $fault: 'client',
    $metadata: { httpStatusCode: status },
  });
}

function gaxiosError(status: number) {
  return Object.assign(new Error(`Request failed with status ${status}`), {
    response: { status, data: { error: 'denied' } },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  nock.cleanAll();
});

describe('AWS', () => {
  const request = {
    cloudProvider: CloudType.AWS,
    kind: 'role',
    roleArn: 'arn:aws:iam::123456789012:role/anycloud',
  } as const;

  const session = {
    Credentials: {
      AccessKeyId: 'ASIATRIAL',
      SecretAccessKey: 'trial-secret',
      SessionToken: 'trial-session',
      Expiration: new Date(Date.now() + 12 * 3600_000),
    },
  };

  /**
   * STS answering as a role whose trust admits `trust`'s tokens, optionally
   * failing one probe. The OIDC provider lists only sts.amazonaws.com, except
   * that an 'any audience' trust stands for one that also lists the probe
   * audience: real STS checks the client IDs before the trust policy.
   */
  function sts(
    trust: Trust,
    probeFailure?: Error,
    failing: 'subject' | 'audience' = 'subject',
  ) {
    const sent: unknown[] = [];
    vi.spyOn(STSClient.prototype, 'send').mockImplementation(
      async (command: unknown) => {
        sent.push(command);
        if (!(command instanceof AssumeRoleWithWebIdentityCommand))
          return { Account: '123456789012' };
        const token = command.input.WebIdentityToken!;
        const probe = claims(token).aud.includes(TRUST_PROBE_AUDIENCE)
          ? 'audience'
          : claims(token).sub === PROBE_SUBJECT && 'subject';
        if (probeFailure && probe === failing) throw probeFailure;
        if (admits(trust, token, 'sts.amazonaws.com')) return session;
        if (!claims(token).aud.includes('sts.amazonaws.com'))
          throw new InvalidIdentityTokenException({
            message: STS_INVALID_TOKEN,
            $metadata: { httpStatusCode: 400 },
          });
        throw stsError(
          'AccessDenied',
          'Not authorized to perform sts:AssumeRoleWithWebIdentity',
          403,
        );
      },
    );
    return sent;
  }

  test('0047/S17 assumes a pinned role for 12 hours with a session that can do nothing, proves the trust refuses another subject and audience, and records it', async () => {
    const sent = sts('pinned');
    const { run, audiences } = check();

    await expect(run(request)).resolves.toEqual({
      ...request,
      issuer: ISSUER,
      audience: 'sts.amazonaws.com',
      subject: SUBJECT,
    });
    expect(audiences).toEqual(['sts.amazonaws.com', TRUST_PROBE_AUDIENCE]);
    const [assume, identity, ...probes] = sent as [
      AssumeRoleWithWebIdentityCommand,
      GetCallerIdentityCommand,
      ...AssumeRoleWithWebIdentityCommand[],
    ];
    expect(assume.input).toMatchObject({
      RoleArn: request.roleArn,
      WebIdentityToken: serviceAccountToken('sts.amazonaws.com'),
      DurationSeconds: 43_200,
    });
    const denyAll = {
      Version: '2012-10-17',
      Statement: [{ Effect: 'Deny', Action: '*', Resource: '*' }],
    };
    expect(JSON.parse(assume.input.Policy!)).toEqual(denyAll);
    expect(identity).toBeInstanceOf(GetCallerIdentityCommand);
    expect(probes.map(({ input }) => input.WebIdentityToken)).toEqual([
      serviceAccountToken('sts.amazonaws.com', PROBE_SUBJECT),
      serviceAccountToken(TRUST_PROBE_AUDIENCE),
    ]);
    for (const { input } of probes) {
      // Should STS accept a probe, its session can do nothing, for 15 minutes.
      expect(input).toMatchObject({
        RoleArn: request.roleArn,
        DurationSeconds: 900,
      });
      expect(JSON.parse(input.Policy!)).toEqual(denyAll);
    }
  });

  test.each(unpinned)(
    '0047/S17 a trust that does not pin the %s is refused, naming it',
    async (claim, trust, accepted) => {
      sts(trust);

      const refusal = await failure(check().run(request));
      expect(refusal).toBeInstanceOf(RoleConnectionCheckError);
      expect(refusal.message).toContain(
        `The trust of AWS role ${request.roleArn} accepted a token with ${claim} ${accepted}, so it does not pin the ${claim}.`,
      );
    },
  );

  test.each([
    ['throttling', stsError('Throttling', 'Rate exceeded', 400)],
    ['HTTP 429', stsError('TooManyRequests', 'Too many requests', 429)],
    ['a 5xx', stsError('InternalFailure', 'Internal failure', 500)],
    [
      'an issuer AWS cannot reach',
      new IDPCommunicationErrorException({
        message: 'Couldn’t retrieve verification key',
        $metadata: { httpStatusCode: 400 },
      }),
    ],
    [
      'an issuer key STS cannot fetch',
      new InvalidIdentityTokenException({
        message:
          'Couldn’t retrieve verification key from your identity provider',
        $metadata: { httpStatusCode: 400 },
      }),
    ],
    ['a network failure', new Error('socket hang up')],
  ])(
    '0047/S17 a probe ending in %s asks for the save again',
    async (_case, error) => {
      sts('any subject', error);

      await expectProbeRetried(
        check().run(request),
        `AWS role ${request.roleArn}`,
      );
    },
  );

  test.each([
    [
      'an issuer key STS cannot fetch',
      new InvalidIdentityTokenException({
        message:
          'Couldn’t retrieve verification key from your identity provider',
        $metadata: { httpStatusCode: 400 },
      }),
    ],
    [
      'an invalid-token answer that is not the audience refusal',
      new InvalidIdentityTokenException({
        message: `No OpenIDConnect provider found in your account for ${ISSUER}`,
        $metadata: { httpStatusCode: 400 },
      }),
    ],
    ['throttling', stsError('Throttling', 'Rate exceeded', 400)],
    ['a 5xx', stsError('InternalFailure', 'Internal failure', 500)],
  ])(
    '0047/S17 an audience probe ending in %s asks for the save again',
    async (_case, error) => {
      sts('any audience', error, 'audience');

      await expectProbeRetried(
        check().run(request),
        `AWS role ${request.roleArn}`,
        'audience',
      );
    },
  );

  test('0047/S17 an invalid-token answer to the subject probe does not prove the subject pinned', async () => {
    sts(
      'any subject',
      new InvalidIdentityTokenException({
        message: STS_INVALID_TOKEN,
        $metadata: { httpStatusCode: 400 },
      }),
    );

    await expectProbeRetried(
      check().run(request),
      `AWS role ${request.roleArn}`,
    );
  });

  test('an abandoned save ends with its abort, not a request to repeat it', async () => {
    const save = new AbortController();
    const abort = new Error('aborted');
    vi.spyOn(STSClient.prototype, 'send').mockImplementation(
      async (command: unknown) => {
        if (!(command instanceof AssumeRoleWithWebIdentityCommand))
          return { Account: '123456789012' };
        if (claims(command.input.WebIdentityToken!).sub === SUBJECT)
          return session;
        save.abort(abort);
        throw abort;
      },
    );

    await expect(check().run(request, save.signal)).rejects.toBe(abort);
  });

  test('passes the save’s signal to STS, so an abandoned save stores nothing', async () => {
    const send = vi
      .spyOn(STSClient.prototype, 'send')
      .mockRejectedValue(new Error('aborted'));
    const signal = new AbortController().signal;

    await expect(check().run(request, signal)).rejects.toThrow('aborted');
    expect(send.mock.calls[0]![1]).toEqual({ abortSignal: signal });
  });

  const trusted = `a token from issuer ${ISSUER} with audience sts.amazonaws.com and subject ${SUBJECT}`;
  test.each([
    [
      '0047/S15 a role left at a 1-hour MaxSessionDuration',
      stsError(
        'ValidationError',
        'The requested DurationSeconds exceeds the MaxSessionDuration set for this role.',
        400,
      ),
      'Set its MaxSessionDuration to 43200',
    ],
    [
      '0047/S15 a trust with the wrong audience',
      new InvalidIdentityTokenException({
        message: STS_INVALID_TOKEN,
        $metadata: { httpStatusCode: 400 },
      }),
      trusted,
    ],
    [
      '0047/S15 a trust with the wrong subject',
      stsError(
        'AccessDenied',
        'Not authorized to perform sts:AssumeRoleWithWebIdentity',
        403,
      ),
      trusted,
    ],
    [
      'an issuer AWS cannot read',
      new IDPCommunicationErrorException({
        message:
          'Couldn’t retrieve verification key from your identity provider',
        $metadata: { httpStatusCode: 400 },
      }),
      trusted,
    ],
  ])('%s is refused with the reason', async (_case, error, reason) => {
    vi.spyOn(STSClient.prototype, 'send').mockRejectedValue(error);

    const refusal = await check()
      .run(request)
      .catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(RoleConnectionCheckError);
    expect((refusal as Error).message).toContain(reason);
    expect((refusal as Error).message).toContain(error.message);
  });

  test.each([
    ['Throttling', stsError('Throttling', 'Rate exceeded', 400)],
    ['HTTP 429', stsError('TooManyRequests', 'Too many requests', 429)],
  ])(
    'a rate limit (%s) asks for the save again instead of refusing',
    async (_case, error) => {
      vi.spyOn(STSClient.prototype, 'send').mockRejectedValue(error);

      const pending = await check()
        .run(request)
        .catch((e: unknown) => e);
      expect(pending).toBeInstanceOf(RoleConnectionPendingError);
      expect((pending as Error).message).toContain('AWS is throttling');
    },
  );

  test('a network failure is not mistaken for a refusal', async () => {
    const failure = new Error('socket hang up');
    vi.spyOn(STSClient.prototype, 'send').mockRejectedValue(failure);

    await expect(check().run(request)).rejects.toBe(failure);
  });
});

describe('GCP', () => {
  const request = {
    cloudProvider: CloudType.GCP,
    kind: 'role',
    workloadIdentityProvider: PROVIDER,
    serviceAccountEmail: 'anycloud@my-project-1.iam.gserviceaccount.com',
  } as const;
  const audience = `https://iam.googleapis.com/${PROVIDER}`;

  /**
   * GCP answering as a provider and impersonation binding whose trust admits
   * `trust`'s tokens: STS refuses another audience with 400, and the binding
   * another subject with 403.
   */
  function gcp(trust: Trust, probeFailure?: Error) {
    const exchanged: unknown[] = [];
    vi.spyOn(IdentityPoolClient.prototype, 'getAccessToken').mockImplementation(
      async function (this: IdentityPoolClient) {
        const client = this as unknown as {
          audience: string;
          serviceAccountImpersonationUrl: string;
          subjectTokenSupplier: { getSubjectToken(): Promise<string> };
        };
        const subjectToken =
          await client.subjectTokenSupplier.getSubjectToken();
        exchanged.push({
          audience: client.audience,
          impersonation: client.serviceAccountImpersonationUrl,
          subjectToken,
        });
        if (probeFailure && claims(subjectToken).sub === PROBE_SUBJECT)
          throw probeFailure;
        if (admits(trust, subjectToken, audience)) return { token: 'access' };
        throw gaxiosError(
          claims(subjectToken).aud.includes(audience) ? 403 : 400,
        );
      },
    );
    return exchanged;
  }

  test('0047/S17 exchanges a token for the provider, impersonates the account, and proves the trust refuses another subject and audience', async () => {
    const exchanged = gcp('pinned');

    await expect(check().run(request)).resolves.toEqual({
      ...request,
      issuer: ISSUER,
      audience,
      subject: SUBJECT,
    });
    const through = {
      audience: `//iam.googleapis.com/${PROVIDER}`,
      impersonation: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${request.serviceAccountEmail}:generateAccessToken`,
    };
    expect(exchanged).toEqual(
      [
        serviceAccountToken(audience),
        serviceAccountToken(audience, PROBE_SUBJECT),
        serviceAccountToken(TRUST_PROBE_AUDIENCE),
      ].map((subjectToken) => ({ ...through, subjectToken })),
    );
  });

  test.each(unpinned)(
    '0047/S17 a trust that does not pin the %s is refused, naming it',
    async (claim, trust, accepted) => {
      gcp(trust);

      const refusal = await failure(check().run(request));
      expect(refusal).toBeInstanceOf(RoleConnectionCheckError);
      expect(refusal.message).toContain(
        `The trust of GCP service account ${request.serviceAccountEmail} through ${PROVIDER} accepted a token with ${claim} ${accepted}, so it does not pin the ${claim}.`,
      );
    },
  );

  test.each([
    ['HTTP 429', gaxiosError(429)],
    ['a 5xx', gaxiosError(503)],
    ['a network failure', new Error('socket hang up')],
  ])(
    '0047/S17 a probe ending in %s asks for the save again',
    async (_case, error) => {
      gcp('any subject', error);

      await expectProbeRetried(
        check().run(request),
        `GCP service account ${request.serviceAccountEmail} through ${PROVIDER}`,
      );
    },
  );

  test('an impersonation GCP IAM has not granted yet asks for the save again, after one exchange', async () => {
    const exchange = vi
      .spyOn(IdentityPoolClient.prototype, 'getAccessToken')
      .mockRejectedValue(gaxiosError(403));

    const pending = await check()
      .run(request)
      .catch((e: unknown) => e);
    expect(pending).toBeInstanceOf(RoleConnectionPendingError);
    expect((pending as Error).message).toContain(
      `Waiting for GCP IAM to let ${request.serviceAccountEmail}`,
    );
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  test('a rate limit asks for the save again instead of refusing', async () => {
    vi.spyOn(IdentityPoolClient.prototype, 'getAccessToken').mockRejectedValue(
      gaxiosError(429),
    );

    const pending = await check()
      .run(request)
      .catch((e: unknown) => e);
    expect(pending).toBeInstanceOf(RoleConnectionPendingError);
    expect((pending as Error).message).toContain('GCP is throttling');
  });

  test('0047/S15 a token STS refuses is refused', async () => {
    vi.spyOn(IdentityPoolClient.prototype, 'getAccessToken').mockRejectedValue(
      gaxiosError(400),
    );

    await expect(check().run(request)).rejects.toBeInstanceOf(
      RoleConnectionCheckError,
    );
  });
});

describe('Azure', () => {
  const request = {
    cloudProvider: CloudType.Azure,
    kind: 'role',
    applicationId: '00000000-0000-0000-0000-00000000000a',
    directoryId: '00000000-0000-0000-0000-00000000000d',
    subscriptionId: '00000000-0000-0000-0000-00000000000e',
  } as const;
  const login = 'https://login.microsoftonline.com';

  /** Entra ID's discovery, so MSAL reaches the token endpoint. */
  function entraId() {
    nock.disableNetConnect();
    const tenant = `${login}/${request.directoryId}`;
    nock(login)
      .persist()
      .get('/common/discovery/instance')
      .query(true)
      .reply(200, {
        tenant_discovery_endpoint: `${tenant}/v2.0/.well-known/openid-configuration`,
        metadata: [],
      })
      .get(`/${request.directoryId}/v2.0/.well-known/openid-configuration`)
      .reply(200, {
        token_endpoint: `${tenant}/oauth2/v2.0/token`,
        authorization_endpoint: `${tenant}/oauth2/v2.0/authorize`,
        end_session_endpoint: `${tenant}/oauth2/v2.0/logout`,
        issuer: `${login}/${request.directoryId}/v2.0`,
        jwks_uri: `${login}/${request.directoryId}/discovery/v2.0/keys`,
      });
    return nock(login)
      .post(`/${request.directoryId}/oauth2/v2.0/token`)
      .query(true);
  }

  /** ARM's resource group listing, answering each read in turn. */
  /** ARM's resource group listing: 200, or an error status and code. */
  function resourceGroups(...answers: (200 | [number, string])[]) {
    const authorizations: string[] = [];
    let scope = nock('https://management.azure.com');
    for (const answer of answers)
      scope = scope
        .get(`/subscriptions/${request.subscriptionId}/resourcegroups`)
        .query(true)
        .reply(function () {
          authorizations.push(this.req.headers.authorization as string);
          return answer === 200
            ? [200, { value: [] }]
            : [
                answer[0],
                {
                  error: { code: answer[1], message: `${answer[1]} for test` },
                },
              ];
        });
    return authorizations;
  }

  const exchangeAudience = 'api://AzureADTokenExchange';

  /**
   * Entra ID answering as a federated credential that admits `trust`'s
   * assertions; a probe's exchange can instead end in `probeFailure`, an HTTP
   * status or a network error.
   */
  function entra(
    trust: Trust,
    probeFailure?: number | Error | { status: number; aadsts: string },
  ) {
    const assertions: string[] = [];
    entraId()
      .times(10)
      .reply((_uri, body, reply) => {
        const assertion = new URLSearchParams(body as string).get(
          'client_assertion',
        )!;
        assertions.push(assertion);
        if (
          probeFailure !== undefined &&
          claims(assertion).sub === PROBE_SUBJECT
        )
          return typeof probeFailure === 'number'
            ? reply(null, [probeFailure, { error: 'temporarily_unavailable' }])
            : 'aadsts' in probeFailure
              ? reply(null, [
                  probeFailure.status,
                  {
                    error: 'temporarily_unavailable',
                    error_description: `${probeFailure.aadsts}: The server terminated an operation because it encountered a client request loop.`,
                    error_codes: [50196],
                  },
                ])
              : reply(probeFailure, [0, '']); // the result is ignored
        if (admits(trust, assertion, exchangeAudience))
          return reply(null, [
            200,
            { token_type: 'Bearer', access_token: 'arm', expires_in: 3600 },
          ]);
        const claim = claims(assertion).aud.includes(exchangeAudience)
          ? 'subject'
          : 'audience';
        return reply(null, [
          400,
          {
            error: 'invalid_client',
            error_description: `AADSTS70021${claim === 'subject' ? 3 : 2}: No matching federated identity record found for presented assertion ${claim}.`,
            error_codes: [claim === 'subject' ? 700213 : 700212],
          },
        ]);
      });
    return assertions;
  }

  test('0047/S17 gets a management token with the client assertion, reads ARM with it, and proves the trust refuses another subject and audience', async () => {
    const armReads = resourceGroups(200);
    const assertions = entra('pinned');
    const { run, audiences } = check();

    await expect(run(request)).resolves.toEqual({
      ...request,
      issuer: ISSUER,
      audience: exchangeAudience,
      subject: SUBJECT,
    });
    expect(new Set(audiences)).toEqual(
      new Set([exchangeAudience, TRUST_PROBE_AUDIENCE]),
    );
    // ARM asks for its own token, with continuous access evaluation.
    expect(new Set(assertions)).toEqual(
      new Set([
        serviceAccountToken(exchangeAudience),
        serviceAccountToken(exchangeAudience, PROBE_SUBJECT),
        serviceAccountToken(TRUST_PROBE_AUDIENCE),
      ]),
    );
    expect(armReads).toEqual(['Bearer arm']);
  });

  test.each(unpinned)(
    '0047/S17 a trust that does not pin the %s is refused, naming it',
    async (claim, trust, accepted) => {
      resourceGroups(200);
      entra(trust);

      const refusal = await failure(check().run(request));
      expect(refusal).toBeInstanceOf(RoleConnectionCheckError);
      expect(refusal.message).toContain(
        `The trust of Azure application ${request.applicationId} accepted a token with ${claim} ${accepted}, so it does not pin the ${claim}.`,
      );
    },
  );

  test.each([
    ['HTTP 429', 429],
    [
      'an Entra ID throttle with an AADSTS code',
      { status: 429, aadsts: 'AADSTS50196' },
    ],
    ['a 5xx', 503],
    ['a network failure', new Error('socket hang up')],
  ])(
    '0047/S17 a probe ending in %s asks for the save again',
    async (_case, probeFailure) => {
      resourceGroups(200);
      entra('any subject', probeFailure);

      await expectProbeRetried(
        check().run(request),
        `Azure application ${request.applicationId}`,
      );
    },
  );

  test('waits for Azure permissions, then saves once the role assignment arrives', async () => {
    resourceGroups([403, 'AuthorizationFailed'], 200);
    entra('pinned');
    const { run } = check();

    await expect(run(request)).rejects.toBeInstanceOf(
      RoleConnectionPendingError,
    );
    await expect(run(request)).resolves.toMatchObject({
      applicationId: request.applicationId,
    });
  });

  test.each([
    [404, 'SubscriptionNotFound'],
    [401, 'InvalidAuthenticationTokenTenant'],
  ])('refuses an ARM %i %s, naming the subscription', async (status, code) => {
    resourceGroups([status, code]);
    entra('pinned');

    const refusal = await check()
      .run(request)
      .catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(RoleConnectionCheckError);
    expect((refusal as Error).message).toContain(request.subscriptionId);
  });

  test('0047/S15 a federated credential that does not match is refused', async () => {
    entraId().reply(400, {
      error: 'invalid_client',
      error_description:
        'AADSTS700213: No matching federated identity record found for presented assertion subject.',
      error_codes: [700213],
    });

    const refusal = await check()
      .run(request)
      .catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(RoleConnectionCheckError);
    expect((refusal as Error).message).toContain('AADSTS700213');
  });

  test('a network failure is not mistaken for a refusal', async () => {
    entraId().replyWithError('socket hang up');

    const failure = await check()
      .run(request)
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(RoleConnectionCheckError);
  });
});
