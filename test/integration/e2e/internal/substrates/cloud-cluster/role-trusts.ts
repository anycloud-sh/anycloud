import { ClientSecretCredential } from '@azure/identity';
import { JWT } from 'google-auth-library';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { CloudCredential } from '../../../../../../src/shared/api-contract/credentials-schemas.js';
import { CloudType } from '../../../../../../src/shared/cloud.js';
import type {
  ExchangeOutcome,
  RoleCloud,
  TrustVariant,
} from '../../contracts/role-connections.js';
import type { ProcessRunner } from '../../process.js';
import type { Waiter } from '../../wait.js';
import { type CommandResult, errorMessage } from '../../types.js';

/**
 * Each cloud's side of a role connection in the live checks (RFC 0047 S14 to
 * S17): the trust deployed from the setup template the hosted API serves, the
 * changes S15 and S17 make to it, the exchanges the runner makes with minted
 * ServiceAccount tokens and no credential of its own, and the deletion that
 * proves every object is gone. Object names are `e2e-role-<ms>-<rand>`, which
 * the workflow's sweep reclaims once stale (ci/cleanup/e2e-cluster-stale-ids.ts).
 */

/** The API's ServiceAccount, which every pinned trust names. */
export const API_SUBJECT = 'system:serviceaccount:anycloud-system:anycloud-api';
/** Values no trust names, for S15's wrong trusts. */
export const WRONG_AUDIENCE = 'https://anycloud.sh/e2e-wrong-audience';
export const WRONG_SUBJECT =
  'system:serviceaccount:anycloud-system:e2e-wrong-subject';

/** What a deployed trust gives `credentials new --role`, and the audience it pins. */
export interface DeployedTrust {
  readonly identifiers: Readonly<Record<string, string>>;
  readonly audience: string;
}

export interface CloudTrust {
  deploy(template: string): Promise<DeployedTrust>;
  /** Undefined once applied; the cloud's refusal when it can't express the variant. */
  apply(variant: TrustVariant): Promise<string | undefined>;
  exchange(token: string): Promise<ExchangeOutcome>;
  /** Deletes what `deploy` created; each line names an object proven gone. */
  remove(): Promise<readonly string[]>;
}

/** Every trust's subjects and audiences beyond the API's own, from lane R3. */
export interface ProbeIdentity {
  readonly subject: string;
  readonly audience: string;
}

/**
 * The exchange's answer as the runner sees it: any 2xx accepts; throttling
 * and server errors are transient and thrown; anything else is the cloud
 * refusing the token, its body kept as the reason.
 */
export function exchangeOutcome(status: number, body: string): ExchangeOutcome {
  if (status >= 200 && status < 300) return { accepted: true };
  if (status === 429 || status >= 500) {
    throw new Error(
      `transient exchange answer ${status}: ${body.slice(0, 300)}`,
    );
  }
  return { accepted: false, refusal: `${status} ${body.slice(0, 400)}` };
}

type TrustStatement = {
  readonly Condition?: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
} & Readonly<Record<string, unknown>>;
interface TrustPolicy {
  readonly Version: string;
  readonly Statement: readonly TrustStatement[];
}

/**
 * The AWS trust policy for a variant, from the template's pinned one: its
 * one statement's `StringEquals` on `<host>:aud` and `<host>:sub`.
 */
export function awsTrustPolicy(
  pinned: TrustPolicy,
  host: string,
  variant: TrustVariant,
): TrustPolicy {
  const [statement] = pinned.Statement;
  if (pinned.Statement.length !== 1 || !statement)
    throw new Error('the template trust policy has more than one statement');
  const aud = `${host}:aud`;
  const sub = `${host}:sub`;
  const equals = statement.Condition?.StringEquals ?? {};
  const condition = ((): Record<string, Record<string, string>> | undefined => {
    switch (variant) {
      case 'pinned':
      case 'short-session':
        return { StringEquals: { ...equals } };
      case 'wrong-audience':
        return { StringEquals: { ...equals, [aud]: WRONG_AUDIENCE } };
      case 'wrong-subject':
        return { StringEquals: { ...equals, [sub]: WRONG_SUBJECT } };
      case 'any-subject':
        return {
          StringEquals: { [aud]: equals[aud] },
          StringLike: { [sub]: 'system:serviceaccount:*' },
        };
      case 'any-audience':
        return { StringEquals: { [sub]: equals[sub] } };
      case 'issuer-only':
        return undefined;
    }
  })();
  const { Condition: _, ...rest } = statement;
  return {
    Version: pinned.Version,
    Statement: [condition ? { ...rest, Condition: condition } : rest],
  };
}

/** The GCP provider fields a variant sets: its allowed audiences and condition. */
export function gcpProviderFields(
  pinned: { readonly audiences: readonly string[]; readonly condition: string },
  variant: TrustVariant,
  probe: ProbeIdentity,
): { readonly audiences: readonly string[]; readonly condition: string } {
  switch (variant) {
    case 'wrong-audience':
      return { ...pinned, audiences: [WRONG_AUDIENCE] };
    case 'wrong-subject':
      return { ...pinned, condition: `assertion.sub == '${WRONG_SUBJECT}'` };
    case 'any-subject':
      return { ...pinned, condition: '' };
    case 'any-audience':
      return { ...pinned, audiences: [...pinned.audiences, probe.audience] };
    default:
      return pinned;
  }
}

/**
 * The Azure federated credentials a variant leaves on the identity: the
 * template's one, changed for S15, or beside a second admitting the probe's
 * subject or audience for S17 (Azure has no wildcard form).
 */
export function azureFederatedCredentials(
  issuer: string,
  audience: string,
  variant: TrustVariant,
  probe: ProbeIdentity,
): Readonly<
  Record<string, { issuer: string; subject: string; audiences: string[] }>
> {
  const own = { issuer, subject: API_SUBJECT, audiences: [audience] };
  switch (variant) {
    case 'wrong-audience':
      return { 'anycloud-api': { ...own, audiences: [WRONG_AUDIENCE] } };
    case 'wrong-subject':
      return { 'anycloud-api': { ...own, subject: WRONG_SUBJECT } };
    case 'any-subject':
      return {
        'anycloud-api': own,
        'e2e-probe': { ...own, subject: probe.subject },
      };
    case 'any-audience':
      return {
        'anycloud-api': own,
        'e2e-probe': { ...own, audiences: [probe.audience] },
      };
    default:
      return { 'anycloud-api': own };
  }
}

function ok(result: CommandResult, operation: string): string {
  if (result.exitCode === 0 && !result.timedOut && !result.spawnError)
    return result.stdout;
  throw new Error(
    `${operation} failed (exit ${String(result.exitCode)}): ${result.combined.slice(-2000)}`,
  );
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, body: await response.text() };
}

interface TrustOptions {
  readonly name: string;
  readonly issuer: string;
  readonly runner: Pick<ProcessRunner, 'run'>;
  readonly probe: ProbeIdentity;
  readonly wait: Pick<Waiter, 'for'>;
}

/**
 * A command line: the literal text split on whitespace, each value one
 * argument as is, so a JSON document or a path with spaces stays whole.
 */
export function argv(
  literals: TemplateStringsArray,
  ...values: readonly string[]
): string[] {
  const args: string[] = [];
  literals.forEach((text, index) => {
    const words = text.split(/\s+/u);
    // Text right before a value, with no space between, prefixes it.
    const glued = index < values.length ? words.pop()! : '';
    args.push(...words.filter(Boolean));
    if (index < values.length) args.push(`${glued}${values[index]}`);
  });
  return args;
}

/** A CloudFormation stack of the template; the role and provider IAM names. */
export class AwsTrust implements CloudTrust {
  readonly #o: TrustOptions;
  readonly #env: Record<string, string | undefined>;
  #roleArn = '';
  #pinned: TrustPolicy | undefined;
  #providerArn = '';

  constructor(options: TrustOptions, credential: CloudCredential) {
    if (credential.cloudProvider !== CloudType.AWS)
      throw new Error('AwsTrust needs an AWS credential');
    this.#o = options;
    this.#env = {
      ...Object.fromEntries(
        Object.keys(process.env)
          .filter((n) => n.startsWith('AWS_'))
          .map((n) => [n, undefined]),
      ),
      AWS_ACCESS_KEY_ID: credential.accessKeyId,
      AWS_SECRET_ACCESS_KEY: credential.secretAccessKey,
      AWS_DEFAULT_REGION: 'us-east-1',
    };
  }

  #run(args: readonly string[], timeoutMs = 120_000) {
    return this.#o.runner.run(
      'aws',
      [...args, '--output', 'json', '--no-cli-pager'],
      {
        label: `role-aws-${args[1] ?? ''}`,
        timeoutMs,
        env: this.#env,
      },
    );
  }

  async #aws(args: readonly string[], timeoutMs?: number): Promise<string> {
    return ok(
      await this.#run(args, timeoutMs),
      `aws ${args.slice(0, 2).join(' ')}`,
    );
  }

  get #host(): string {
    return this.#o.issuer.slice('https://'.length);
  }

  get #roleName(): string {
    return this.#roleArn.split('/').at(-1)!;
  }

  async deploy(template: string): Promise<DeployedTrust> {
    const name = this.#o.name;
    const dir = await mkdtemp(path.join(tmpdir(), 'role-aws-'));
    try {
      const file = path.join(dir, 'template.json');
      await writeFile(file, template);
      await this.#aws(
        argv`cloudformation deploy --stack-name ${name} --template-file ${file} --capabilities CAPABILITY_IAM --tags anycloud_e2e=${name}`,
        900_000,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    const stack = JSON.parse(
      await this.#aws(
        argv`cloudformation describe-stacks --stack-name ${name}`,
      ),
    ) as {
      Stacks: { Outputs?: { OutputKey: string; OutputValue: string }[] }[];
    };
    this.#roleArn =
      stack.Stacks[0]?.Outputs?.find((o) => o.OutputKey === 'RoleArn')
        ?.OutputValue ?? '';
    if (!this.#roleArn) throw new Error(`stack ${name} has no RoleArn output`);
    this.#providerArn = `arn:aws:iam::${this.#roleArn.split(':')[4]}:oidc-provider/${this.#host}`;
    const role = JSON.parse(
      await this.#aws(argv`iam get-role --role-name ${this.#roleName}`),
    ) as {
      Role: { AssumeRolePolicyDocument: TrustPolicy };
    };
    this.#pinned = role.Role.AssumeRolePolicyDocument;
    return {
      identifiers: { 'role-arn': this.#roleArn },
      audience: 'sts.amazonaws.com',
    };
  }

  async apply(variant: TrustVariant): Promise<undefined> {
    if (!this.#pinned) throw new Error('AWS trust not deployed');
    const role = this.#roleName;
    const policy = JSON.stringify(
      awsTrustPolicy(this.#pinned, this.#host, variant),
    );
    const hours = variant === 'short-session' ? '3600' : '43200';
    await this.#aws(
      argv`iam update-assume-role-policy --role-name ${role} --policy-document ${policy}`,
    );
    await this.#aws(
      argv`iam update-role --role-name ${role} --max-session-duration ${hours}`,
    );
    // IAM checks `aud` against the provider's client IDs before the trust
    // policy, so an unpinned audience is the probe's added there too.
    const verb =
      variant === 'any-audience'
        ? 'add-client-id-to-open-id-connect-provider'
        : 'remove-client-id-from-open-id-connect-provider';
    await this.#aws(
      argv`iam ${verb} --open-id-connect-provider-arn ${this.#providerArn} --client-id ${this.#o.probe.audience}`,
    );
    return undefined;
  }

  async exchange(token: string): Promise<ExchangeOutcome> {
    const query = new URLSearchParams({
      Action: 'AssumeRoleWithWebIdentity',
      Version: '2011-06-15',
      RoleArn: this.#roleArn,
      RoleSessionName: 'e2e-role-exchange',
      WebIdentityToken: token,
      DurationSeconds: '900',
    });
    const response = await fetch(
      `https://sts.amazonaws.com/?${query.toString()}`,
      { signal: AbortSignal.timeout(30_000) },
    );
    return exchangeOutcome(response.status, await response.text());
  }

  async remove(): Promise<readonly string[]> {
    const name = this.#o.name;
    await this.#aws(argv`cloudformation delete-stack --stack-name ${name}`);
    await this.#aws(
      argv`cloudformation wait stack-delete-complete --stack-name ${name}`,
      900_000,
    );
    if (!this.#roleArn) return [`stack ${name} (no role was created)`];
    const gone: string[] = [];
    for (const [args, what] of [
      [
        argv`iam get-role --role-name ${this.#roleName}`,
        `role ${this.#roleName}`,
      ],
      [
        argv`iam get-open-id-connect-provider --open-id-connect-provider-arn ${this.#providerArn}`,
        `OIDC provider ${this.#host}`,
      ],
    ] as const) {
      const result = await this.#run(args, 60_000);
      if (!/NoSuchEntity/u.test(result.combined))
        throw new Error(
          `AWS ${what} remains after the stack's deletion: ${result.combined.slice(0, 300)}`,
        );
      gone.push(what);
    }
    return gone;
  }
}

const GCP_IAM = 'https://iam.googleapis.com/v1';

/** The template script run with gcloud; the pool, provider and account named per run. */
export class GcpTrust implements CloudTrust {
  readonly #o: TrustOptions;
  readonly #credential: Extract<
    CloudCredential,
    { cloudProvider: CloudType.GCP }
  >;
  readonly #auth: JWT;
  #provider = '';
  #email = '';
  #pinned: { audiences: readonly string[]; condition: string } | undefined;

  constructor(options: TrustOptions, credential: CloudCredential) {
    if (credential.cloudProvider !== CloudType.GCP)
      throw new Error('GcpTrust needs a GCP credential');
    this.#o = options;
    this.#credential = credential;
    this.#auth = new JWT({
      email: credential.clientEmail,
      key: credential.privateKey,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
  }

  async #api<T>(
    method: 'GET' | 'PATCH' | 'POST' | 'DELETE',
    url: string,
    data?: unknown,
  ): Promise<T> {
    const response = await this.#auth.request<T>({
      method,
      url,
      data,
      timeout: 30_000,
    });
    return response.data;
  }

  /** A GET answered by its status, for objects IAM may not show yet or any more. */
  async #get<T>(url: string): Promise<{ status: number; data: T }> {
    const { status, data } = await this.#auth.request<T>({
      url,
      validateStatus: () => true,
      timeout: 30_000,
    });
    return { status, data };
  }

  /**
   * The env names the template script reads its object IDs from (lane R1),
   * kept here in one place.
   */
  #scriptEnvironment(): Record<string, string> {
    return {
      ANYCLOUD_ROLE_POOL: this.#o.name,
      ANYCLOUD_ROLE_PROVIDER: this.#o.name,
      ANYCLOUD_ROLE_SERVICE_ACCOUNT: this.#o.name,
    };
  }

  async deploy(template: string): Promise<DeployedTrust> {
    const { projectId, clientEmail, privateKey } = this.#credential;
    const dir = await mkdtemp(path.join(tmpdir(), 'role-gcp-'));
    try {
      const key = path.join(dir, 'key.json');
      const script = path.join(dir, 'setup.sh');
      await writeFile(
        key,
        JSON.stringify({
          type: 'service_account',
          project_id: projectId,
          client_email: clientEmail,
          private_key: privateKey,
          token_uri: 'https://oauth2.googleapis.com/token',
        }),
        { mode: 0o600 },
      );
      await writeFile(script, template);
      const env = {
        CLOUDSDK_CONFIG: path.join(dir, 'gcloud'),
        CLOUDSDK_CORE_PROJECT: projectId,
        CLOUDSDK_CORE_DISABLE_PROMPTS: '1',
        ...this.#scriptEnvironment(),
      };
      ok(
        await this.#o.runner.run(
          'gcloud',
          [
            'auth',
            'activate-service-account',
            clientEmail,
            `--key-file=${key}`,
          ],
          { label: 'role-gcp-auth', env, timeoutMs: 60_000 },
        ),
        'gcloud auth',
      );
      await rm(key);
      const out = ok(
        await this.#o.runner.run('bash', [script], {
          label: 'role-gcp-setup',
          env,
          cwd: dir,
          timeoutMs: 900_000,
        }),
        'GCP setup script',
      );
      this.#provider =
        /workload identity provider:\s*(\S+)/u.exec(out)?.[1] ?? '';
      this.#email = /service account email:\s*(\S+)/u.exec(out)?.[1] ?? '';
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    if (!this.#provider || !this.#email)
      throw new Error(
        'the GCP setup script did not print the provider and service account',
      );
    // IAM can answer 404 for a provider the script has just created.
    const { data: provider } = await this.#o.wait.for(
      `GCP provider ${this.#provider} readable`,
      () =>
        this.#get<{
          attributeCondition?: string;
          oidc: { allowedAudiences?: string[] };
        }>(`${GCP_IAM}/${this.#provider}`),
      {
        timeoutMs: 120_000,
        intervalMs: 5_000,
        probeError: 'fail',
        reject: ({ status }) =>
          status >= 300 && status !== 404 ? `status ${status}` : undefined,
        unmet: ({ status }) => (status === 404 ? 'status 404' : undefined),
      },
    );
    this.#pinned = {
      audiences: provider.oidc.allowedAudiences ?? [],
      condition: provider.attributeCondition ?? '',
    };
    return {
      identifiers: {
        'workload-identity-provider': this.#provider,
        'service-account-email': this.#email,
      },
      audience: `https://iam.googleapis.com/${this.#provider}`,
    };
  }

  #serviceAccountUrl(email = this.#email): string {
    return `${GCP_IAM}/projects/${this.#credential.projectId}/serviceAccounts/${email}`;
  }

  async apply(variant: TrustVariant): Promise<undefined> {
    if (!this.#pinned) throw new Error('GCP trust not deployed');
    const fields = gcpProviderFields(this.#pinned, variant, this.#o.probe);
    await this.#api(
      'PATCH',
      `${GCP_IAM}/${this.#provider}?updateMask=attributeCondition,oidc.allowedAudiences`,
      {
        attributeCondition: fields.condition,
        oidc: { allowedAudiences: fields.audiences },
      },
    );
    // Unpinned subject: the binding admits every identity in the pool.
    const pool = this.#provider.replace(/\/providers\/[^/]+$/u, '');
    const everyone = `principalSet://iam.googleapis.com/${pool}/*`;
    const policy = await this.#api<{
      bindings?: { role: string; members: string[] }[];
      etag: string;
    }>('POST', `${this.#serviceAccountUrl()}:getIamPolicy`);
    const bindings = (policy.bindings ?? []).map((b) =>
      b.role === 'roles/iam.workloadIdentityUser'
        ? {
            ...b,
            members: [
              ...b.members.filter((m) => m !== everyone),
              ...(variant === 'any-subject' ? [everyone] : []),
            ],
          }
        : b,
    );
    await this.#api('POST', `${this.#serviceAccountUrl()}:setIamPolicy`, {
      policy: { ...policy, bindings },
    });
    return undefined;
  }

  async exchange(token: string): Promise<ExchangeOutcome> {
    const sts = await postJson('https://sts.googleapis.com/v1/token', {
      grantType: 'urn:ietf:params:oauth:grant-type:token-exchange',
      audience: `//iam.googleapis.com/${this.#provider}`,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      requestedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
      subjectToken: token,
      subjectTokenType: 'urn:ietf:params:oauth:token-type:jwt',
    });
    const federated = exchangeOutcome(sts.status, sts.body);
    if (!federated.accepted) return federated;
    const accessToken = (JSON.parse(sts.body) as { access_token: string })
      .access_token;
    const impersonated = await postJson(
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${this.#email}:generateAccessToken`,
      {
        scope: ['https://www.googleapis.com/auth/cloud-platform'],
        lifetime: '600s',
      },
      { authorization: `Bearer ${accessToken}` },
    );
    return exchangeOutcome(impersonated.status, impersonated.body);
  }

  /**
   * By the run's names, so a script that failed partway is removed too. Each
   * object's removal runs even when an earlier one failed, and the failures
   * are reported together.
   */
  async remove(): Promise<readonly string[]> {
    const gone: string[] = [];
    const failures: string[] = [];
    const attempt = async (step: () => Promise<string>) => {
      try {
        gone.push(await step());
      } catch (error) {
        failures.push(errorMessage(error));
      }
    };
    await attempt(() => this.#removeServiceAccount());
    const pool = `projects/${this.#credential.projectId}/locations/global/workloadIdentityPools/${this.#o.name}`;
    for (const resource of [`${pool}/providers/${this.#o.name}`, pool])
      await attempt(() => this.#removePoolObject(resource));
    if (failures.length)
      throw new Error(`GCP trust ${this.#o.name}: ${failures.join('; ')}`);
    return gone;
  }

  async #removeServiceAccount(): Promise<string> {
    const { projectId } = this.#credential;
    const email =
      this.#email || `${this.#o.name}@${projectId}.iam.gserviceaccount.com`;
    const project = `https://cloudresourcemanager.googleapis.com/v1/projects/${projectId}`;
    const member = `serviceAccount:${email}`;
    const projectPolicy = () =>
      this.#api<{ bindings?: { role: string; members: string[] }[] }>(
        'POST',
        `${project}:getIamPolicy`,
        { options: { requestedPolicyVersion: 3 } },
      );
    const names = (p: Awaited<ReturnType<typeof projectPolicy>>) =>
      p.bindings?.some((b) => b.members.includes(member)) ?? false;
    const policy = await projectPolicy();
    if (names(policy)) {
      const bindings = policy
        .bindings!.map((b) => ({
          ...b,
          members: b.members.filter((m) => m !== member),
        }))
        .filter((b) => b.members.length > 0);
      await this.#api('POST', `${project}:setIamPolicy`, {
        policy: { ...policy, bindings },
      });
    }
    const account = this.#serviceAccountUrl(email);
    if ((await this.#get(account)).status !== 404)
      await this.#api('DELETE', account);
    if (names(await projectPolicy()))
      throw new Error(`the project policy still names ${member}`);
    // IAM can still serve a just-deleted account for a while.
    await this.#o.wait.for(
      `GCP service account ${email} deleted`,
      async () => (await this.#get(account)).status,
      {
        timeoutMs: 300_000,
        intervalMs: 5_000,
        probeError: 'fail',
        reject: (status) =>
          status === 401 || status === 403 ? `status ${status}` : undefined,
        unmet: (status) =>
          status === 404 ? undefined : `service account remains (${status})`,
      },
    );
    return `service account ${email} and its project binding`;
  }

  async #removePoolObject(resource: string): Promise<string> {
    const found = await this.#get<{ state?: string }>(`${GCP_IAM}/${resource}`);
    if (found.status === 404) return `${resource} (never created)`;
    if (found.data.state !== 'DELETED')
      await this.#api('DELETE', `${GCP_IAM}/${resource}`);
    // A deleted pool or provider stays as a tombstone for 30 days; IAM can
    // still read it ACTIVE for a while after the DELETE.
    await this.#o.wait.for(
      `GCP ${resource} deleted`,
      () => this.#api<{ state: string }>('GET', `${GCP_IAM}/${resource}`),
      {
        timeoutMs: 300_000,
        intervalMs: 5_000,
        probeError: 'fail',
        unmet: ({ state }) =>
          state === 'DELETED' ? undefined : `${state} after its deletion`,
      },
    );
    return `${resource} (DELETED)`;
  }
}

const ARM = 'https://management.azure.com';
const MANAGED_IDENTITY_API = '2023-01-31';
/**
 * The role checks' Azure region for trusts and the connection's region,
 * outside the regions another tenant's workloads use in the shared
 * subscription. Buckets are containers in the subscription's one storage
 * account, wherever it was created.
 */
export const AZURE_ROLE_REGION = 'eastus2';

/** A subscription deployment of the template; its resource group named per run. */
export class AzureTrust implements CloudTrust {
  readonly #o: TrustOptions;
  readonly #credential: Extract<
    CloudCredential,
    { cloudProvider: CloudType.Azure }
  >;
  readonly #token: ClientSecretCredential;
  #clientId = '';
  #principalId = '';
  #audience = 'api://AzureADTokenExchange';

  constructor(options: TrustOptions, credential: CloudCredential) {
    if (credential.cloudProvider !== CloudType.Azure)
      throw new Error('AzureTrust needs an Azure credential');
    this.#o = options;
    this.#credential = credential;
    this.#token = new ClientSecretCredential(
      credential.directoryId,
      credential.applicationId,
      credential.secret,
    );
  }

  async #arm(
    method: string,
    url: string,
    apiVersion: string,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const { token } = await this.#token.getToken(`${ARM}/.default`);
    const response = await fetch(
      `${ARM}${url}${url.includes('?') ? '&' : '?'}api-version=${apiVersion}`,
      {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    const text = await response.text();
    if (response.status >= 400 && response.status !== 404)
      throw new Error(
        `ARM ${method} ${url}: ${response.status} ${text.slice(0, 400)}`,
      );
    return {
      status: response.status,
      body: (text ? JSON.parse(text) : {}) as Record<string, unknown>,
    };
  }

  get #group(): string {
    return `/subscriptions/${this.#credential.subscriptionId}/resourceGroups/${this.#o.name}`;
  }

  get #identity(): string {
    return `${this.#group}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/anycloud-role`;
  }

  async deploy(template: string): Promise<DeployedTrust> {
    const url = `/subscriptions/${this.#credential.subscriptionId}/providers/Microsoft.Resources/deployments/${this.#o.name}`;
    await this.#arm('PUT', url, '2021-04-01', {
      location: AZURE_ROLE_REGION,
      properties: {
        mode: 'Incremental',
        template: JSON.parse(template) as unknown,
        parameters: { resourceGroup: { value: this.#o.name } },
      },
    });
    const properties = await this.#o.wait.for(
      `Azure deployment ${this.#o.name}`,
      async () =>
        (await this.#arm('GET', url, '2021-04-01')).body.properties as {
          provisioningState?: string;
          outputs?: Record<string, { value: string }>;
          error?: unknown;
        },
      {
        timeoutMs: 15 * 60_000,
        intervalMs: 15_000,
        probeError: 'fail',
        unmet: (p) =>
          p.provisioningState === 'Succeeded'
            ? undefined
            : `state ${String(p.provisioningState)}`,
        reject: (p) =>
          p.provisioningState === 'Failed' || p.provisioningState === 'Canceled'
            ? `${p.provisioningState}: ${JSON.stringify(p.error ?? {})}`
            : undefined,
      },
    );
    const outputs = properties.outputs ?? {};
    this.#clientId = outputs.applicationId?.value ?? '';
    const identity = await this.#arm(
      'GET',
      this.#identity,
      MANAGED_IDENTITY_API,
    );
    this.#principalId = String(
      (identity.body.properties as { principalId?: string } | undefined)
        ?.principalId ?? '',
    );
    if (!this.#clientId || !this.#principalId)
      throw new Error(`Azure deployment ${this.#o.name} has no identity`);
    return {
      identifiers: {
        'application-id': this.#clientId,
        'directory-id':
          outputs.directoryId?.value ?? this.#credential.directoryId,
        'subscription-id':
          outputs.subscriptionId?.value ?? this.#credential.subscriptionId,
      },
      audience: this.#audience,
    };
  }

  async apply(variant: TrustVariant): Promise<string | undefined> {
    const wanted = azureFederatedCredentials(
      this.#o.issuer,
      this.#audience,
      variant,
      this.#o.probe,
    );
    // One identity's credentials take one write at a time.
    for (const [name, properties] of Object.entries(wanted)) {
      try {
        await this.#arm(
          'PUT',
          `${this.#identity}/federatedIdentityCredentials/${name}`,
          MANAGED_IDENTITY_API,
          { properties },
        );
      } catch (error) {
        // A trust Azure refuses to hold can't be misconfigured that way (owner's coordinator).
        if (
          variant === 'any-audience' &&
          name === 'e2e-probe' &&
          /\b400\b/u.test(String(error))
        )
          return String(error);
        throw error;
      }
    }
    if (!('e2e-probe' in wanted))
      await this.#arm(
        'DELETE',
        `${this.#identity}/federatedIdentityCredentials/e2e-probe`,
        MANAGED_IDENTITY_API,
      );
    return undefined;
  }

  async exchange(token: string): Promise<ExchangeOutcome> {
    const response = await fetch(
      `https://login.microsoftonline.com/${this.#credential.directoryId}/oauth2/v2.0/token`,
      {
        method: 'POST',
        body: new URLSearchParams({
          client_id: this.#clientId,
          scope: `${ARM}/.default`,
          grant_type: 'client_credentials',
          client_assertion_type:
            'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
          client_assertion: token,
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    return exchangeOutcome(response.status, await response.text());
  }

  async remove(): Promise<readonly string[]> {
    const gone: string[] = [];
    const scope = `/subscriptions/${this.#credential.subscriptionId}`;
    // A deployment that failed partway may have assigned the role already.
    if (!this.#principalId) {
      const identity = await this.#arm(
        'GET',
        this.#identity,
        MANAGED_IDENTITY_API,
      );
      this.#principalId = String(
        (identity.body.properties as { principalId?: string } | undefined)
          ?.principalId ?? '',
      );
    }
    const assignments = async () =>
      this.#principalId
        ? (((
            await this.#arm(
              'GET',
              `${scope}/providers/Microsoft.Authorization/roleAssignments?$filter=${encodeURIComponent(`principalId eq '${this.#principalId}'`)}`,
              '2022-04-01',
            )
          ).body.value as { id: string }[] | undefined) ?? [])
        : [];
    // A subscription-scope assignment outlives its principal's resource group.
    for (const { id } of await assignments())
      await this.#arm('DELETE', id, '2022-04-01');
    if ((await assignments()).length)
      throw new Error(`role assignments remain for ${this.#principalId}`);
    gone.push(`role assignments of ${this.#principalId || 'no identity'}`);
    await this.#arm('DELETE', this.#group, '2021-04-01');
    await this.#o.wait.for(
      `Azure resource group ${this.#o.name} deleted`,
      async () => (await this.#arm('GET', this.#group, '2021-04-01')).status,
      {
        timeoutMs: 15 * 60_000,
        intervalMs: 15_000,
        probeError: 'fail',
        unmet: (status) => (status === 404 ? undefined : `status ${status}`),
      },
    );
    gone.push(
      `resource group ${this.#o.name} with its identity and federated credentials`,
    );
    return gone;
  }
}

/** Each cloud's trust for this run. */
export function cloudTrust(
  cloud: RoleCloud,
  options: TrustOptions,
  credential: CloudCredential,
): CloudTrust {
  switch (cloud) {
    case 'aws':
      return new AwsTrust(options, credential);
    case 'gcp':
      return new GcpTrust(options, credential);
    case 'azure':
      return new AzureTrust(options, credential);
  }
}
