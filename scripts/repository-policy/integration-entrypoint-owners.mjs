import parser from '@typescript-eslint/parser';

const ownerArrayNames = [
  'shellNativeQualificationTests',
  'destructiveBackstopTests',
  'shellIntegrationTests',
  'integrationUtilities',
];

export function parseIntegrationEntrypointOwners(source) {
  const errors = [];
  let ast;
  try {
    ({ ast } = parser.parseForESLint(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
    }));
  } catch (error) {
    return {
      errors: [
        `entrypoint owner registry is not valid JavaScript: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ],
    };
  }

  const initializers = new Map();
  for (const statement of ast.body) {
    if (
      statement.type !== 'ExportNamedDeclaration' ||
      statement.declaration?.type !== 'VariableDeclaration' ||
      statement.declaration.kind !== 'const'
    ) {
      continue;
    }
    for (const declaration of statement.declaration.declarations) {
      if (
        declaration.id.type !== 'Identifier' ||
        !ownerArrayNames.includes(declaration.id.name)
      ) {
        continue;
      }
      if (
        declaration.init?.type !== 'ArrayExpression' ||
        initializers.has(declaration.id.name)
      ) {
        errors.push(
          `${declaration.id.name} must be one exported const array literal`,
        );
        continue;
      }
      initializers.set(declaration.id.name, declaration.init.elements);
    }
  }

  const resolved = new Map();
  const resolveArray = (name, stack = new Set()) => {
    if (resolved.has(name)) return resolved.get(name);
    const elements = initializers.get(name);
    if (!elements) {
      errors.push(`${name} is missing from the entrypoint owner registry`);
      return [];
    }
    if (stack.has(name)) {
      errors.push(`${name} contains a cyclic spread`);
      return [];
    }
    const nextStack = new Set(stack).add(name);
    const values = [];
    for (const element of elements) {
      if (element?.type === 'Literal' && typeof element.value === 'string') {
        values.push(element.value);
      } else if (
        element?.type === 'SpreadElement' &&
        element.argument.type === 'Identifier' &&
        ownerArrayNames.includes(element.argument.name)
      ) {
        values.push(...resolveArray(element.argument.name, nextStack));
      } else {
        errors.push(
          `${name} may contain only literal paths and named owner-array spreads`,
        );
      }
    }
    resolved.set(name, values);
    return values;
  };

  for (const name of ownerArrayNames) resolveArray(name);
  for (const name of ownerArrayNames) {
    const values = resolved.get(name) ?? [];
    if (new Set(values).size !== values.length) {
      errors.push(`${name} contains duplicate paths`);
    }
  }
  const expectedShellSources = [
    ...(resolved.get('shellNativeQualificationTests') ?? []),
    ...(resolved.get('destructiveBackstopTests') ?? []),
  ];
  if (
    JSON.stringify(resolved.get('shellIntegrationTests') ?? []) !==
    JSON.stringify(expectedShellSources)
  ) {
    errors.push(
      'shellIntegrationTests must exactly compose the two source-owner arrays',
    );
  }
  return Object.fromEntries([
    ['errors', errors],
    ...ownerArrayNames.map((name) => [name, resolved.get(name) ?? []]),
  ]);
}

// These remain shell because Docker/process, installed-artifact, or provider
// parity behavior is their native outer interface. Their assertions may still
// move behind typed helpers without pretending the launcher is a Workload
// contract.
export const shellNativeQualificationTests = [
  'test/integration/api-image.test.sh',
  'test/integration/api-startup.test.sh',
  'test/integration/binary.test.sh',
  'test/integration/install-script.test.sh',
  'test/integration/installed-wizard.test.sh',
  'test/integration/quota.test.sh',
];

// Destructive account cleanup is an independent last-resort backstop.
export const destructiveBackstopTests = ['test/integration/nuke.test.sh'];

export const shellIntegrationTests = [
  ...shellNativeQualificationTests,
  ...destructiveBackstopTests,
];

// Existing executable utilities and temporary probes have explicit owners.
// Helpers absent from this list remain libraries. Caller graphs are not policy.
export const integrationUtilities = [
  'test/integration/helpers/test-fail-assert.sh',
  'test/integration/helpers/test-api-http-reconciliation.sh',
  'test/integration/helpers/lambda-boot-failover-cleanup.sh',
  'test/integration/helpers/api-ssh-reaping.sh',
  'test/integration/helpers/api-ssh-drain.sh',
  'test/integration/helpers/api-http-shutdown.mjs',
  'test/integration/helpers/api-process.ts',
  'test/integration/helpers/azure-quota-public-ip-selection.ts',
  'test/integration/helpers/azure-quota-compute-limit.ts',
  'test/integration/helpers/e2e-run-record.ts',
  'test/integration/helpers/process-e2e-logs.ts',
  'test/integration/helpers/mace-report.ts',
  'test/integration/helpers/observe-ac-timing.mjs',
  'test/integration/helpers/workload-fixture-cli.ts',
  'test/integration/helpers/nuke-classify-outcomes.mjs',
  'test/integration/helpers/nuke-fairness.mjs',
  'test/integration/helpers/nuke-memory-budget.mjs',
  'test/integration/helpers/nuke-host-metrics.mjs',
  'test/integration/helpers/nuke-image-evidence.ts',
  'test/integration/credentials-onboarding/aws/cleanup.ts',
  'test/integration/credentials-onboarding/gcp/cleanup.ts',
  'test/integration/credentials-onboarding/azure/cleanup.ts',
  'test/integration/credentials-onboarding/azure/identity-readback-cli.ts',
  'test/integration/credentials-onboarding/azure/runner-loss.ts',
  'test/integration/fixtures/generated-python-sdk-models.py',
  'test/integration/fixtures/qualify-python-sdk-extensions.py',
  'test/integration/fixtures/qualify-python-sdk-artifacts.py',
  'test/integration/credentials-onboarding/aws/bucket-import.ts',
  'test/integration/credentials-onboarding/gcp/bucket-import.ts',
  'test/integration/probe-containerd-parallel-pull.sh',
  'test/integration/lambda-boot-probe.sh',
];
