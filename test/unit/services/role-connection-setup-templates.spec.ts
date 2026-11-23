import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import anycloudAccess from '../../../src/shared/cloud-policies/aws-anycloud-access.json' with { type: 'json' };
import azureRole from '../../../src/shared/cloud-policies/azure-anycloud-role.json' with { type: 'json' };
import gcpRole from '../../../src/shared/cloud-policies/gcp-anycloud-role.json' with { type: 'json' };
import {
  awsRoleSetupTemplate,
  azureRoleSetupTemplate,
  gcpRoleSetupScript,
  RoleSetupTemplateError,
  type RoleSetupTrust,
} from '../../../src/api/services/role-connection-setup-templates.js';

/**
 * RFC 0047 § Role connections: each cloud's setup template is generated from
 * its published policy or role, and its trust pins the issuer, the audience
 * and the subject, never a wildcard or the issuer alone (§ Trust conditions).
 */

const ISSUER = 'https://c-1.anycloud.sh';
const SUBJECT = 'system:serviceaccount:anycloud-system:anycloud-api';
const TRUST: RoleSetupTrust = {
  issuer: ISSUER,
  subject: SUBJECT,
  audience: 'sts.amazonaws.com',
};
const THUMBPRINT = 'a'.repeat(40);

// Each way a trust could stop being pinned to one issuer, subject and audience.
const UNPINNED: Array<[string, Partial<RoleSetupTrust>]> = [
  ['a missing issuer', { issuer: undefined }],
  ['an empty issuer', { issuer: '' }],
  ['a wildcard issuer', { issuer: 'https://*.anycloud.sh' }],
  ['a plain-HTTP issuer', { issuer: 'http://c-1.anycloud.sh' }],
  ['an issuer that breaks out of a quote', { issuer: "https://c-1.sh'x" }],
  ['a missing subject', { subject: undefined }],
  ['an empty subject', { subject: '' }],
  [
    'a wildcard subject',
    { subject: 'system:serviceaccount:anycloud-system:*' },
  ],
  [
    'a namespace-wide subject',
    { subject: 'system:serviceaccount:anycloud-system' },
  ],
];

const UNPINNED_AUDIENCE: Array<[string, Partial<RoleSetupTrust>]> = [
  ['a missing audience', { audience: undefined }],
  ['an empty audience', { audience: '' }],
  ['a wildcard audience', { audience: '*' }],
  ['an audience pattern', { audience: 'sts.*' }],
];

// GCP's audience is its provider's own URL, which the script derives.
const generators: Array<
  [string, (trust: RoleSetupTrust) => unknown, typeof UNPINNED]
> = [
  [
    'AWS',
    (trust) => awsRoleSetupTemplate(trust, THUMBPRINT),
    [...UNPINNED, ...UNPINNED_AUDIENCE],
  ],
  ['GCP', gcpRoleSetupScript, UNPINNED],
  ['Azure', azureRoleSetupTemplate, [...UNPINNED, ...UNPINNED_AUDIENCE]],
];

describe.each(generators)('%s setup template', (_cloud, generate, cases) => {
  it.each(cases)('refuses %s', (_case, change) => {
    const trust: RoleSetupTrust = Object.assign({}, TRUST, change);
    expect(() => generate(trust)).toThrow(RoleSetupTemplateError);
  });
});

/**
 * What CloudFormation deploys for one IssuerProviderExists value: the
 * template's conditions, Fn::If and Fn::Sub resolved in an account.
 */
function deployAws(template: unknown, providerExists?: 'true' | 'false') {
  const { Parameters, Conditions, Resources } = template as {
    Parameters: Record<string, { Default: string; AllowedValues: string[] }>;
    Conditions: Record<string, unknown>;
    Resources: Record<string, { Condition?: string; Properties: unknown }>;
  };
  const parameter = Parameters.IssuerProviderExists;
  const value = providerExists ?? parameter.Default;
  expect(parameter.AllowedValues).toContain(value);
  const pseudo: Record<string, string> = {
    'AWS::Partition': 'aws',
    'AWS::AccountId': '123456789012',
  };
  const resolve = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(resolve);
    if (!node || typeof node !== 'object') return node;
    const object = node as Record<string, unknown>;
    if ('Ref' in object)
      return object.Ref === 'IssuerProviderExists'
        ? value
        : { Ref: object.Ref };
    if ('Fn::Equals' in object) {
      const [left, right] = resolve(object['Fn::Equals']) as unknown[];
      return left === right;
    }
    if ('Fn::If' in object) {
      const [condition, then, otherwise] = object['Fn::If'] as unknown[];
      return resolve(
        resolve(Conditions[condition as string]) ? then : otherwise,
      );
    }
    if ('Fn::Sub' in object)
      return (object['Fn::Sub'] as string).replace(
        /\$\{([^}]+)\}/g,
        (_match, name: string) => pseudo[name] ?? `\${${name}}`,
      );
    return Object.fromEntries(
      Object.entries(object).map(([key, child]) => [key, resolve(child)]),
    );
  };
  return Object.fromEntries(
    Object.entries(Resources)
      .filter(
        ([, resource]) =>
          !resource.Condition || resolve(Conditions[resource.Condition]),
      )
      .map(([name, resource]) => [name, resolve(resource.Properties)]),
  ) as {
    Issuer?: Record<string, unknown>;
    Role: {
      MaxSessionDuration: number;
      AssumeRolePolicyDocument: { Statement: unknown[] };
      Policies: Array<{ PolicyName: string; PolicyDocument: unknown }>;
    };
  };
}

const PINNED_CONDITION = {
  StringEquals: {
    'c-1.anycloud.sh:aud': 'sts.amazonaws.com',
    'c-1.anycloud.sh:sub': SUBJECT,
  },
};

describe('AWS CloudFormation template', () => {
  const template = awsRoleSetupTemplate(TRUST, THUMBPRINT);
  const Role = deployAws(template).Role;

  it('by default creates the OIDC provider for exactly the issuer, its audience and thumbprint, and trusts only it', () => {
    const deployed = deployAws(template);
    expect(deployed.Issuer).toEqual({
      Url: ISSUER,
      ClientIdList: ['sts.amazonaws.com'],
      ThumbprintList: [THUMBPRINT],
    });
    expect(deployed.Role.AssumeRolePolicyDocument.Statement).toEqual([
      {
        Effect: 'Allow',
        Principal: { Federated: { Ref: 'Issuer' } },
        Action: 'sts:AssumeRoleWithWebIdentity',
        Condition: PINNED_CONDITION,
      },
    ]);
  });

  // IAM keeps one provider per issuer URL in an account, and the API
  // cluster's backup trust may already have made it (RFC 0049).
  it("with IssuerProviderExists=true trusts the account's provider for the same issuer, still pinning aud and sub", () => {
    const deployed = deployAws(template, 'true');
    expect(deployed.Issuer).toBeUndefined();
    expect(deployed.Role.AssumeRolePolicyDocument.Statement).toEqual([
      {
        Effect: 'Allow',
        Principal: {
          Federated: 'arn:aws:iam::123456789012:oidc-provider/c-1.anycloud.sh',
        },
        Action: 'sts:AssumeRoleWithWebIdentity',
        Condition: PINNED_CONDITION,
      },
    ]);
  });

  // A boolean, not an ARN, so the stack can't federate another provider.
  it('admits only true or false for IssuerProviderExists', () => {
    expect(
      (template as { Parameters: Record<string, unknown> }).Parameters,
    ).toEqual({
      IssuerProviderExists: expect.objectContaining({
        AllowedValues: ['false', 'true'],
        Default: 'false',
      }),
    });
  });

  it('grants the published AnycloudAccess for 12-hour sessions', () => {
    expect(Role.MaxSessionDuration).toBe(43200);
    expect(Role.Policies).toEqual([
      { PolicyName: 'AnycloudAccess', PolicyDocument: anycloudAccess },
    ]);
  });

  it.each(['', 'A'.repeat(40), 'a'.repeat(39), undefined])(
    'refuses the thumbprint %j',
    (thumbprint) => {
      expect(() =>
        awsRoleSetupTemplate(TRUST, thumbprint as unknown as string),
      ).toThrow(RoleSetupTemplateError);
    },
  );
});

describe('GCP Cloud Shell script', () => {
  const script = gcpRoleSetupScript(TRUST);
  const POOL_NAME =
    'projects/123/locations/global/workloadIdentityPools/anycloud';

  /** Runs the script against a fake gcloud that records each call. */
  function run(
    env: Record<string, string> = {},
    pool: {
      state?: string;
      providers?: string;
      deletedProvider?: string;
      listFails?: string;
      roleExists?: string;
      /** The existing provider's fields, as `describe --format=value(...)` prints them. */
      provider?: Record<string, string>;
    } = {},
  ) {
    const dir = mkdtempSync(join(tmpdir(), 'gcp-role-setup-'));
    const gcloud = join(dir, 'gcloud');
    writeFileSync(
      gcloud,
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${dir}/calls"
case "$*" in
  "config get-value project") echo proj ;;
  "projects describe proj"*) echo 123 ;;
  "services list"*) echo compute.googleapis.com ;;
  "iam workload-identity-pools describe"*) [ -n "${pool.state ?? ''}" ] && echo ${pool.state ?? ''} || exit 1 ;;
  "iam workload-identity-pools providers list"*) [ -z "${pool.listFails ?? ''}" ] || exit 1; echo "${pool.providers ?? ''}" ;;
${Object.entries(pool.provider ?? {})
  .map(
    ([field, value]) =>
      `  "iam workload-identity-pools providers describe"*"value(${field})") printf '%s\\n' ${JSON.stringify(value)} ;;`,
  )
  .join('\n')}
  "iam workload-identity-pools providers describe"*) [ -n "${pool.deletedProvider ?? ''}" ] || exit 1 ;;
  "iam service-accounts describe"*) exit 1 ;;
  "iam roles create"*) [ -z "${pool.roleExists ?? ''}" ] || exit 1 ;;
esac
`,
    );
    chmodSync(gcloud, 0o755);
    const result = spawnSync('bash', ['-c', script], {
      cwd: dir,
      encoding: 'utf8',
      env: { PATH: `${dir}:${process.env.PATH}`, ...env },
    });
    const calls = existsSync(join(dir, 'calls'))
      ? readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n')
      : [];
    const role = existsSync(join(dir, 'anycloud-role.json'))
      ? readFileSync(join(dir, 'anycloud-role.json'), 'utf8')
      : '';
    rmSync(dir, { recursive: true });
    return { ...result, calls, role };
  }

  it('pins the provider to the issuer, its own audience and the subject, and binds one principal', () => {
    const { status, calls, stdout } = run();
    expect(status).toBe(0);
    expect(calls).toContain(
      'iam workload-identity-pools providers create-oidc anycloud-api ' +
        '--location=global --workload-identity-pool=anycloud ' +
        `--issuer-uri=${ISSUER} ` +
        `--allowed-audiences=https://iam.googleapis.com/${POOL_NAME}/providers/anycloud-api ` +
        '--attribute-mapping=google.subject=assertion.sub ' +
        `--attribute-condition=assertion.sub == '${SUBJECT}'`,
    );
    const members = calls.flatMap(
      (call) => /--member=(principal\S*)/.exec(call)?.[1] ?? [],
    );
    expect(members).toEqual([
      `principal://iam.googleapis.com/${POOL_NAME}/subject/${SUBJECT}`,
    ]);
    expect(script).not.toContain('principalSet');
    // Only the services not yet enabled.
    expect(calls.filter((call) => call.startsWith('services enable'))).toEqual([
      'services enable iam.googleapis.com',
      'services enable iamcredentials.googleapis.com',
      'services enable sts.googleapis.com',
    ]);
    expect(stdout).toContain(
      `workload identity provider: ${POOL_NAME}/providers/anycloud-api`,
    );
    expect(stdout).toContain(
      'service account email:      anycloud-role@proj.iam.gserviceaccount.com',
    );
  });

  it('creates the published role', () => {
    expect(JSON.parse(run().role)).toEqual(gcpRole);
  });

  it('only adds the published permissions to an existing role', () => {
    const { status, calls } = run({}, { roleExists: 'yes' });
    expect(status).toBe(0);
    // A newer release's permissions, or an administrator's, stay.
    expect(calls.filter((call) => call.startsWith('iam roles update'))).toEqual(
      [
        `iam roles update anycloud --project=proj --add-permissions=${gcpRole.includedPermissions.join(',')} --quiet`,
      ],
    );
  });

  it('uses the resource IDs given in the environment', () => {
    const { status, calls } = run({
      ANYCLOUD_ROLE_POOL: 'run-7-pool',
      ANYCLOUD_ROLE_PROVIDER: 'run-7-provider',
      ANYCLOUD_ROLE_SERVICE_ACCOUNT: 'run-7-account',
      ANYCLOUD_ROLE_CUSTOM_ROLE: 'run7role',
    });
    expect(status).toBe(0);
    expect(calls).toEqual(
      expect.arrayContaining([
        'iam workload-identity-pools create run-7-pool --location=global',
        expect.stringMatching(
          /^iam workload-identity-pools providers create-oidc run-7-provider --location=global --workload-identity-pool=run-7-pool /,
        ),
        'iam service-accounts create run-7-account --display-name=Anycloud role connection',
        expect.stringMatching(/^iam roles create run7role /),
      ]),
    );
  });

  it.each([
    [{ state: 'DELETED' }, 'ANYCLOUD_ROLE_POOL to a new ID'],
    [
      { state: 'ACTIVE', providers: `${POOL_NAME}/providers/old` },
      'already has a provider',
    ],
    [{ state: 'ACTIVE', deletedProvider: 'yes' }, 'ANYCLOUD_ROLE_PROVIDER'],
    // Unable to prove the pool has no provider.
    [{ state: 'ACTIVE', listFails: 'yes' }, ''],
    [{ state: 'STATE_UNSPECIFIED' }, 'ANYCLOUD_ROLE_POOL to a new ID'],
  ])('refuses %j before changing anything', (pool, message) => {
    const { status, stderr, calls } = run({}, pool);
    expect(status).not.toBe(0);
    expect(stderr).toContain(message);
    expect(calls.filter((call) => /create|enable|add-iam/.test(call))).toEqual(
      [],
    );
  });

  const PROVIDER_NAME = `${POOL_NAME}/providers/anycloud-api`;
  const sameTrust = {
    state: 'ACTIVE',
    'oidc.issuerUri': ISSUER,
    'oidc.allowedAudiences': `https://iam.googleapis.com/${PROVIDER_NAME}`,
    attributeCondition: `assertion.sub == '${SUBJECT}'`,
  };

  it('adopts the same provider with the same trust on a re-run, still converging the rest', () => {
    const { status, calls, stdout, stderr } = run(
      {},
      { state: 'ACTIVE', providers: PROVIDER_NAME, provider: sameTrust },
    );
    expect(status).toBe(0);
    // Visible, so a recovery that skipped deleting the provider is noticed.
    expect(stderr).toContain(
      'After a suspected signing-key compromise, delete it and rerun with a new ANYCLOUD_ROLE_PROVIDER',
    );
    expect(calls.some((call) => call.includes('create-oidc'))).toBe(false);
    expect(calls.some((call) => call.startsWith('iam roles create'))).toBe(
      true,
    );
    expect(stdout).toContain(`workload identity provider: ${PROVIDER_NAME}`);
  });

  it.each([
    ['another issuer', { 'oidc.issuerUri': 'https://other.example' }],
    ['another subject', { attributeCondition: "assertion.sub == 'x'" }],
    ['another audience', { 'oidc.allowedAudiences': 'https://x' }],
    ['a disabled provider', { state: 'DISABLED' }],
  ])('refuses the same provider ID with %s', (_label, change) => {
    const { status, stderr, calls } = run(
      {},
      {
        state: 'ACTIVE',
        providers: PROVIDER_NAME,
        provider: { ...sameTrust, ...change },
      },
    );
    expect(status).not.toBe(0);
    expect(stderr).toContain('exists with another trust');
    expect(calls.filter((call) => /create|enable|add-iam/.test(call))).toEqual(
      [],
    );
  });

  it('refuses another active provider in the pool, even with the same trust (a recovery)', () => {
    const { status, stderr } = run(
      {},
      {
        state: 'ACTIVE',
        providers: `${POOL_NAME}/providers/old`,
        provider: sameTrust,
      },
    );
    expect(status).not.toBe(0);
    expect(stderr).toContain('already has a provider');
  });

  it('refuses a resource ID that is not one', () => {
    const { status, calls } = run({ ANYCLOUD_ROLE_POOL: "x'; rm -rf ~" });
    expect(status).not.toBe(0);
    expect(calls).toEqual([]);
  });
});

describe('Azure ARM template', () => {
  const AZURE_TRUST = { ...TRUST, audience: 'api://AzureADTokenExchange' };
  const template = JSON.stringify(azureRoleSetupTemplate(AZURE_TRUST));
  const resources = (
    azureRoleSetupTemplate(AZURE_TRUST) as {
      resources: Array<Record<string, any>>;
    }
  ).resources;
  const identity = resources.find(
    (resource) => resource.type === 'Microsoft.Resources/deployments',
  )?.properties.template.resources as Array<Record<string, any>>;

  it('federates exactly the issuer, subject and audience', () => {
    const credentials = identity.filter((resource) =>
      String(resource.type).endsWith('/federatedIdentityCredentials'),
    );
    expect(credentials.map((resource) => resource.properties)).toEqual([
      {
        issuer: ISSUER,
        subject: SUBJECT,
        audiences: ['api://AzureADTokenExchange'],
      },
    ]);
    expect(template).not.toContain('claimsMatchingExpression');
  });

  it('defines the published role for this subscription only and assigns it', () => {
    const role = resources.find(
      (resource) => resource.type === 'Microsoft.Authorization/roleDefinitions',
    )?.properties;
    expect(role.permissions).toEqual([
      {
        actions: azureRole.Actions,
        notActions: azureRole.NotActions,
        dataActions: azureRole.DataActions,
        notDataActions: azureRole.NotDataActions,
      },
    ]);
    expect(role.assignableScopes).toEqual(['[subscription().id]']);
    // Role names are unique across the tenant.
    expect(role.roleName).toContain('subscription().subscriptionId');
    expect(
      resources.filter(
        (resource) =>
          resource.type === 'Microsoft.Authorization/roleAssignments',
      ),
    ).toHaveLength(1);
  });

  it('creates no app registration, which would need tenant-admin consent', () => {
    expect(template).not.toMatch(/Microsoft\.Graph|applications/i);
  });

  // ARM's documented signatures (template-functions-resource):
  // subscriptionResourceId([subscriptionId], type, names...) and
  // resourceId([subscriptionId], [resourceGroupName], type, names...). At
  // subscription scope a lone leading resourceId argument is read as the
  // subscription ID, so a group's resource needs both.
  it('calls resource ID functions with the arguments their scope takes', () => {
    const calls = resourceIdCalls(
      azureRoleSetupTemplate(AZURE_TRUST),
      'subscription',
    );
    expect(calls.length).toBeGreaterThan(0);
    for (const { name, scope, args } of calls) {
      const type = args.findIndex((arg) => /^'[^']*\/[^']*'$/.test(arg));
      const leading = args.slice(0, type);
      expect(type, `${name}(${args.join(', ')})`).toBeGreaterThanOrEqual(0);
      expect(args.length - type - 1, `${name}(${args.join(', ')})`).toBe(
        args[type].split('/').length - 1,
      );
      const allowed =
        name === 'subscriptionResourceId'
          ? [0, 1]
          : scope === 'subscription'
            ? [0, 2]
            : [0, 1, 2];
      expect(
        allowed,
        `${name}(${args.join(', ')}) at ${scope} scope`,
      ).toContain(leading.length);
      if (leading.length === 2 || name === 'subscriptionResourceId')
        for (const subscription of leading.slice(0, 1))
          expect(subscription).toBe('subscription().subscriptionId');
    }
  });

  it('assigns the role to the identity in the group it deploys', () => {
    const assignment = resources.find(
      (resource) => resource.type === 'Microsoft.Authorization/roleAssignments',
    );
    const nested =
      "reference(resourceId(subscription().subscriptionId, parameters('resourceGroup'), 'Microsoft.Resources/deployments', 'anycloud-identity'))";
    expect(assignment?.properties.principalId).toBe(
      `[${nested}.outputs.principalId.value]`,
    );
    const nestedDeployment = resources.find(
      (resource) => resource.type === 'Microsoft.Resources/deployments',
    )?.properties;
    // Inner scope evaluates the nested outputs in the identity's group.
    expect(nestedDeployment.expressionEvaluationOptions).toEqual({
      scope: 'inner',
    });
    const outputs = nestedDeployment.template.outputs;
    expect(outputs.principalId.value).toBe(
      "[reference(resourceId('Microsoft.ManagedIdentity/userAssignedIdentities', 'anycloud-role')).principalId]",
    );
    expect(outputs.clientId.value).toBe(
      "[reference(resourceId('Microsoft.ManagedIdentity/userAssignedIdentities', 'anycloud-role')).clientId]",
    );
    expect(
      (azureRoleSetupTemplate(AZURE_TRUST) as Record<string, any>).outputs
        .applicationId.value,
    ).toBe(`[${nested}.outputs.clientId.value]`);
  });

  // ARM waits for a referenced resource only when the same template deploys
  // it (template-functions-resource, "Implicit dependency"); any other
  // reference is read as an existing resource, before this deployment runs.
  it('references only resources the outer template deploys', () => {
    const declared = resources.map(
      (resource) =>
        `${resource.type}/${String(resource.name).replace(/^\[(.*)\]$/, '$1')}`,
    );
    const references = outerStrings(azureRoleSetupTemplate(AZURE_TRUST))
      .flatMap((expression) => callArgs(expression, 'reference'))
      .map(([target]) => {
        const [id] = callArgs(target, 'resourceId|subscriptionResourceId');
        const type = id.findIndex((arg) => /^'[^']*\/[^']*'$/.test(arg));
        return [id[type], ...id.slice(type + 1)]
          .map((arg) => arg.replace(/^'(.*)'$/, '$1'))
          .join('/');
      });
    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) expect(declared).toContain(reference);
  });
});

/** Every expression string in a template outside its nested templates. */
function outerStrings(value: unknown): string[] {
  if (typeof value === 'string') return value.startsWith('[') ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(outerStrings);
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]) =>
    key === 'template' ? [] : outerStrings(item),
  );
}

type ResourceIdCall = {
  name: 'resourceId' | 'subscriptionResourceId';
  scope: 'subscription' | 'resourceGroup';
  args: string[];
};

/** Every resource ID call in a template, with the scope ARM evaluates it at. */
function resourceIdCalls(
  value: unknown,
  scope: ResourceIdCall['scope'],
): ResourceIdCall[] {
  if (typeof value === 'string')
    return value.startsWith('[') ? expressionCalls(value, scope) : [];
  if (Array.isArray(value))
    return value.flatMap((item) => resourceIdCalls(item, scope));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]) =>
    // A nested template with inner evaluation runs at its group's scope.
    key === 'template' &&
    (value as { expressionEvaluationOptions?: { scope?: string } })
      .expressionEvaluationOptions?.scope === 'inner'
      ? resourceIdCalls(item, 'resourceGroup')
      : resourceIdCalls(item, scope),
  );
}

function expressionCalls(
  expression: string,
  scope: ResourceIdCall['scope'],
): ResourceIdCall[] {
  return callArgs(expression, 'resourceId|subscriptionResourceId').map(
    (args, index) => ({
      name: [
        ...expression.matchAll(/\b(resourceId|subscriptionResourceId)\(/g),
      ][index][1] as ResourceIdCall['name'],
      scope,
      args,
    }),
  );
}

/** The top-level arguments of each call to the named functions. */
function callArgs(expression: string, names: string): string[][] {
  return [...expression.matchAll(new RegExp(`\\b(?:${names})\\(`, 'g'))].map(
    (match) => {
      const args: string[] = [];
      let depth = 0;
      let quoted = false;
      let current = '';
      for (const char of expression.slice(match.index + match[0].length)) {
        if (char === "'") quoted = !quoted;
        if (!quoted && char === '(') depth++;
        if (!quoted && char === ')' && depth-- === 0) break;
        if (!quoted && char === ',' && depth === 0) {
          args.push(current.trim());
          current = '';
        } else current += char;
      }
      args.push(current.trim());
      return args;
    },
  );
}
