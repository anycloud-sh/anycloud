import eslint from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import localPlugin from './eslint-plugin-local/index.mjs';
import { PROTECTED_ESLINT_RULES } from './scripts/repository-policy/eslint-directive-policy.mjs';

const e2eFiles = ['test/integration/**/*.ts'];
const e2eExecutableHelperFiles = [
  'test/integration/helpers/azure-quota-compute-limit.ts',
  'test/integration/helpers/azure-quota-public-ip-selection.ts',
  'test/integration/helpers/mace-report.ts',
];
const constrainedE2eSpecs = ['test/integration/e2e/specs/**/*.spec.ts'];
const contractE2eSpecs = ['test/integration/e2e/specs/contracts/**/*.spec.ts'];
const closedE2eInternalLayers = [
  'test/integration/e2e/internal/contracts/**/*.{cjs,cts,js,jsx,mjs,mts,ts,tsx}',
  'test/integration/e2e/internal/targets/**/*.{cjs,cts,js,jsx,mjs,mts,ts,tsx}',
];
const noncanonicalE2eInternalLayers = [
  'test/integration/e2e/internal/contracts/**/*.{cjs,cts,js,jsx,mjs,mts,tsx}',
  'test/integration/e2e/internal/targets/**/*.{cjs,cts,js,jsx,mjs,mts,tsx}',
];
// Freeze the pre-RFC integration tests in place. Any newly named integration
// test must use the constrained directory; this prevents an accidental path
// choice from bypassing its fixture-only rules. Remove entries as old tests are
// migrated, but do not add new entries.
const grandfatheredIntegrationTests = [
  'test/integration/aws-cleanup.spec.ts',
  'test/integration/aws-multivpc.spec.ts',
  'test/integration/aws-optimizer-prefilter.spec.ts',
  'test/integration/aws-sad.spec.ts',
  'test/integration/azure-cleanup.spec.ts',
  'test/integration/azure-optimizer-prefilter.spec.ts',
  'test/integration/azure-sad.spec.ts',
  'test/integration/cli-interactive.spec.ts',
  'test/integration/credentials-onboarding/aws/live.spec.ts',
  'test/integration/credentials-onboarding/aws/terminal.spec.ts',
  'test/integration/credentials-onboarding/azure/live.spec.ts',
  'test/integration/credentials-onboarding/azure/terminal.spec.ts',
  'test/integration/credentials-onboarding/common/terminal.spec.ts',
  'test/integration/credentials-onboarding/gcp/live.spec.ts',
  'test/integration/credentials-onboarding/gcp/terminal.spec.ts',
  'test/integration/credentials-onboarding/installed/terminal.spec.ts',
  'test/integration/credentials.test.ts',
  'test/integration/gcp-cleanup.spec.ts',
  'test/integration/gcp-sad.spec.ts',
  'test/integration/ghcr-private-auth.spec.ts',
  'test/integration/image-manifest.spec.ts',
  'test/integration/lambda-cleanup.spec.ts',
  'test/integration/lambda-sad.spec.ts',
  'test/integration/quota.spec.ts',
  'test/integration/slack-handoff.spec.ts',
  'test/integration/ssh-interrupt-container.spec.ts',
  'test/integration/ssh-interrupt.spec.ts',
  'test/integration/ssh-keepalive.spec.ts',
];
// Lower-layer compatibility tests are not workload E2E contracts. Keep this
// list exact and closed rather than forcing protocol and runtime harnesses
// through the RFC 0017 workload fixture.
const lowerLayerIntegrationTests = [
  'test/integration/agent-session-title.spec.ts', // Agent CLI title-format compatibility
  'test/integration/python-api-wire.spec.ts', // RFC 0018 cross-language HTTP wire compatibility
  'test/integration/local-smolvm-runtime.spec.ts', // RFCs 0002/0008 Local SmolVM runtime qualification
  'test/integration/ssh-starvation.spec.ts', // OpenSSH transport isolation against a stock sshd
  'test/integration/credential-lifecycle.spec.ts', // RFC 0034 fake-provider wire lane
  'test/integration/cli-piped-output.spec.ts', // Compiled CLI binary stdio against a fake API; no Workload lifecycle
  'test/integration/cli-seed-smoke.spec.ts', // The compiled seed's cluster create against fake cloud CLIs; no Workload lifecycle
  'test/integration/runner-rclone-sync.spec.ts', // The runner's input sync with the pinned rclone binary; no Workload lifecycle
  'test/integration/pool-job-storage.spec.ts', // RFC 0043: pool Job credentials on real Azure, S3 or GCS storage with the pinned rclone; no Workload lifecycle
  'test/integration/agent-onboarding.spec.ts', // Local: coding agents follow SKILL.md with the released CLI in Docker-in-Docker; the agent owns submission

  'test/integration/kubernetes-host-step.spec.ts', // RFC 0049 C26 (b): the K3s host step on the pinned K3s server; no Workload lifecycle
];

const apiContractBuilderOwner = 'src/shared/api-contract/base.ts';
const apiContractInspectionOwner = 'src/shared/api-contract/inspection.ts';
const localSmolvmBoundaryFiles = [
  'scripts/ci/**/*local-smolvm*.ts',
  'test/integration/local-smolvm-runtime.spec.ts',
];
const workloadAdmissionPersistenceFile =
  'src/api/services/workload-admission-persistence.ts';
const workloadAdmissionWriterFile =
  'src/api/services/workload-admission-writer.ts';
const expressRouteOwnerFiles = [
  'src/api/server.ts',
  'src/api/routes/bucket.ts',
  'src/api/routes/cli.ts',
];
const domainInfrastructurePattern = {
  group: [
    './cloud-config.js',
    './docker.js',
    './monitor.js',
    './persistence.js',
    './telemetry.js',
    './gateways/aws.js',
    './gateways/azure.js',
    './gateways/gcp.js',
    './gateways/github.js',
    './gateways/lambda.js',
    './gateways/local.js',
    './gateways/ssh.js',
    './gateways/transport.js',
    './job/default-operations.js',
    './serve/default-runtime.js',
    '../config.js',
  ],
  message:
    'Domain modules receive infrastructure, runtime, environment, and telemetry capabilities through an explicit dependency port assembled in src/api/composition.ts.',
};
const protectedInlineRules = PROTECTED_ESLINT_RULES;
// The eval family can mint a dynamic import as a string
// (new Function('return import(x)')), invisible to lint and graph alike;
// it is banned and protected everywhere the graph guard runs.
const evalFamilyRules = {
  'no-eval': 'error',
  'no-implied-eval': 'error',
  'no-new-func': 'error',
};
const providerRuntimeFiles = [
  'src/api/services/cloud-config.ts',
  'src/api/services/gateways/**/*.ts',
];
const providerRuntimeTestModeExceptions = [
  // GitHub is an authentication gateway, not a compute/storage provider. Its
  // existing IS_TEST branch owns the explicit test-authentication stub.
  'src/api/services/gateways/github.ts',
];
const environmentAccessOptions = {
  ownerFiles: ['src/api/config.ts'],
  exceptions: [
    {
      file: 'src/api/server.ts',
      variables: ['WORKLOAD_ID', 'IS_TEST', 'SQLITE_PATH'],
      // Written through the constant that src/shared/notifications/source.ts
      // owns and four other call sites share, so the name stays in one place
      // rather than being inlined here.
      indirectVariables: ['API_NOTIFICATION_LABEL_ENV'],
    },
    {
      // Provider unit tests need a deterministic marker before the server
      // composition root binds persistence; production still fails closed.
      file: 'src/api/services/api-identity.ts',
      variables: ['IS_TEST'],
    },
    {
      file: 'src/api/composition.ts',
      variables: ['IS_TEST', 'SQLITE_PATH'],
    },
    {
      // Helm hook Job entrypoint: the chart passes the requested release
      // target through these variables; no other configuration is read.
      file: 'src/api/system-release-hook.ts',
      variables: [
        'ANYCLOUD_RELEASE_REVISION',
        'ANYCLOUD_RELEASE_OPERATION',
        'ANYCLOUD_RELEASE_IMAGE',
        'ANYCLOUD_RELEASE_VERSION',
        'ANYCLOUD_RELEASE_NAMESPACE',
        'ANYCLOUD_API_PORT',
      ],
    },
    {
      // Host-step Job entrypoint: the Job passes its step through these
      // variables (system-release/host-step.ts); no other configuration is read.
      file: 'src/api/host-step.ts',
      variables: [
        'ANYCLOUD_HOST_STEP',
        'ANYCLOUD_HOST_STEP_UNIT',
        'ANYCLOUD_MANAGEMENT_PUBLIC_IP',
        'ANYCLOUD_ISSUER_URL',
      ],
    },
    {
      // The MACE e2e cell opts its test API into the customer GHCR login;
      // the Job host's pre-pull asks the same question.
      file: 'src/api/services/container-image.ts',
      variables: ['IS_TEST', 'ANYCLOUD_E2E_GHCR_AUTH'],
    },
    {
      // CI moves the Local SmolVM bucket root to a directory the runner
      // shares with its Docker daemon at the same path.
      file: 'src/api/services/gateways/local-smolvm-contract.ts',
      variables: ['ANYCLOUD_TEST_LOCAL_BUCKET_ROOT'],
    },
    {
      // e2e-cluster-cloud fails a pool's first launch in one region.
      file: 'src/api/services/node-pool-controller.ts',
      variables: ['ANYCLOUD_E2E_CAPACITY_FAULT'],
    },
    {
      // S12 measures the in-flight cap at 500 on KWOK.
      file: 'src/api/services/deployment-replicas.ts',
      variables: ['IS_TEST', 'ANYCLOUD_E2E_IN_FLIGHT_CAP'],
    },
    {
      // 0.1.71: pool Jobs only in e2e until upgrades drain them.
      file: 'src/api/services/pool-job-admission.ts',
      variables: ['ANYCLOUD_E2E_POOL_JOBS'],
    },
    {
      // ANYCLOUD_GITHUB_API_URL: a loopback fake GitHub for hosted-API tests.
      file: 'src/api/services/gateways/github.ts',
      variables: ['IS_TEST', 'ANYCLOUD_GITHUB_API_URL'],
    },
    {
      // Provider endpoint overrides resolve only here (RFC 0034); every
      // other module takes the resolved URL from these accessors.
      file: 'src/api/services/cloud-endpoints.ts',
      variables: [
        'AZURE_RESOURCE_MANAGER_ENDPOINT',
        'AZURE_AUTHORITY_HOST',
        'GCP_API_ENDPOINT',
        'GOOGLE_CLOUD_UNIVERSE_DOMAIN',
        'STORAGE_EMULATOR_HOST',
        'BIGQUERY_EMULATOR_HOST',
        'LAMBDA_API_BASE_URL',
      ],
    },
    {
      file: 'src/api/services/repositories/db.ts',
      variables: [
        'ANYCLOUD_DB_SLOW_QUERY_MS',
        'ANYCLOUD_TEST_DB_TEMPLATE_PATH',
        'IS_TEST',
        'SQLITE_PATH',
      ],
    },
    {
      file: 'src/api/services/telemetry.ts',
      variables: ['ANYCLOUD_DISABLE_USAGE_COLLECTION', 'IS_TEST'],
    },
  ],
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '.context/**',
      'dist/**',
      'website/**',
      '.stryker-tmp/**',
      'reports/mutation/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
    plugins: {
      local: localPlugin,
    },
    rules: {
      // Object-literal casts hide intent; declare `const x: T = {...}` so the
      // shape is checked against T. Const assertions stay available for
      // literal narrowing, which asserts no target shape.
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'as', objectLiteralTypeAssertions: 'never' },
      ],
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'local/no-raw-error-in-persisted-metadata': 'error',
      'local/no-skipped-or-focused-tests': 'error',
      'local/no-unsafe-type-assertions': 'error',
    },
  },
  {
    files: e2eFiles,
    ignores: e2eExecutableHelperFiles,
    extends: [tseslint.configs.recommendedTypeCheckedOnly],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['test/integration/**/*.{cjs,cts,js,jsx,mjs,mts,ts,tsx}'],
    // The two shared retry utilities own the only retry loops.
    ignores: [
      'test/integration/e2e/internal/wait.ts',
      'test/integration/credentials-onboarding/common/deadline-retry.ts',
    ],
    rules: {
      'local/no-hand-written-retry-loops': 'error',
      'local/protected-rule-disable-policy': [
        'error',
        { protectedRules: ['local/no-hand-written-retry-loops'] },
      ],
    },
  },
  {
    files: [
      'test/integration/**/*.spec.{cjs,cts,js,jsx,mjs,mts,ts,tsx}',
      'test/integration/**/*.test.{cjs,cts,js,jsx,mjs,mts,ts,tsx}',
    ],
    ignores: [
      ...grandfatheredIntegrationTests,
      ...lowerLayerIntegrationTests,
      ...constrainedE2eSpecs,
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Program',
          message:
            'New integration tests must live in test/integration/e2e/specs and use its mandatory fixture.',
        },
      ],
    },
  },
  {
    files: constrainedE2eSpecs,
    linterOptions: {
      noInlineConfig: true,
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'never' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      complexity: ['error', 14],
      'local/no-e2e-escape-hatches': 'error',
      'local/require-e2e-fixture': 'error',
      'local/valid-e2e-spec-shape': 'error',
      'max-depth': ['error', 4],
      'max-lines': [
        'error',
        { max: 320, skipBlankLines: true, skipComments: true },
      ],
      'max-lines-per-function': [
        'error',
        { max: 260, skipBlankLines: true, skipComments: true },
      ],
      'no-console': 'error',
    },
  },
  {
    files: contractE2eSpecs,
    rules: {
      complexity: ['error', 1],
      'local/valid-e2e-contract-spec': 'error',
      'max-lines': [
        'error',
        { max: 35, skipBlankLines: true, skipComments: true },
      ],
      'max-lines-per-function': [
        'error',
        { max: 20, skipBlankLines: true, skipComments: true },
      ],
      'max-statements': ['error', 2],
    },
  },
  {
    files: closedE2eInternalLayers,
    linterOptions: {
      noInlineConfig: true,
    },
    rules: {
      'local/no-e2e-adapter-escape-hatches': 'error',
      'local/no-e2e-raw-mutation-clients': 'error',
      'local/no-e2e-single-member-target-union': 'error',
      'local/no-e2e-raw-vm-ledger-access': 'error',
    },
  },
  {
    files: noncanonicalE2eInternalLayers,
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Program',
          message:
            'Constrained E2E contracts and target adapters must use the canonical .ts extension so strict E2E typechecking cannot be bypassed.',
        },
      ],
    },
  },
  {
    // Every extension the graph cruises; a source file must not shed the
    // module-load rules by its suffix.
    files: ['src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
    linterOptions: {
      reportUnusedDisableDirectives: true,
    },
    rules: {
      // Scoped to src/: test helpers and scripts keep theirs, and a rule with
      // an exception list is a rule nobody reads.
      'local/no-hand-rolled-error-message': 'error',
      'local/api-contract-builder-ownership': [
        'error',
        {
          allowedFiles: [apiContractBuilderOwner],
          checkBuilderCalls: false,
        },
      ],
      'local/api-contract-inspection-ownership': [
        'error',
        { allowedFiles: [apiContractInspectionOwner] },
      ],
      'local/literal-module-loads': 'error',
      'local/no-barrel-reexports': 'error',
      ...evalFamilyRules,
      'local/protected-rule-disable-policy': [
        'error',
        { protectedRules: protectedInlineRules },
      ],
    },
  },
  {
    files: ['src/api/services/*-domain.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [domainInfrastructurePattern],
        },
      ],
    },
  },
  {
    files: ['scripts/**/*.{js,mjs,cjs,ts,tsx,mts,cts}'],
    linterOptions: {
      reportUnusedDisableDirectives: true,
    },
    rules: {
      'local/protected-rule-disable-policy': [
        'error',
        { protectedRules: protectedInlineRules },
      ],
      'local/literal-module-loads': 'error',
      ...evalFamilyRules,
    },
  },
  {
    // Every workload_events writer, including ones a later split adds.
    files: ['src/api/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
    rules: {
      'local/workload-event-metadata-ownership': 'error',
    },
  },
  {
    files: ['src/api/services/workload-admission-*.ts'],
    rules: {
      'local/workload-admission-write-ownership': [
        'error',
        {
          allowedFiles: [
            workloadAdmissionPersistenceFile,
            workloadAdmissionWriterFile,
          ],
        },
      ],
    },
  },
  {
    files: ['src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
    rules: {
      'local/container-spec-write-ownership': 'error',
    },
  },
  {
    files: localSmolvmBoundaryFiles,
    linterOptions: {
      reportUnusedDisableDirectives: true,
    },
    rules: {
      'local/literal-module-loads': 'error',
      ...evalFamilyRules,
      'local/protected-rule-disable-policy': [
        'error',
        {
          protectedRules: [
            ...protectedInlineRules,
            'local/no-hand-written-retry-loops',
          ],
        },
      ],
    },
  },
  {
    files: ['src/shared/api-contract/**/*.ts'],
    rules: {
      'local/api-contract-builder-ownership': [
        'error',
        {
          allowedFiles: [apiContractBuilderOwner],
          checkBuilderCalls: true,
        },
      ],
    },
  },
  {
    files: ['src/**/*.{ts,tsx,mts,cts}'],
    rules: {
      'local/exact-vm-compute-ownership': 'error',
    },
  },
  {
    files: ['src/api/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'local/explicit-api-provider-credentials': 'error',
      // `${error}` yields "[object Object]" for anything without a useful
      // toString, losing the reason at a different boundary. See RFC 0023.
      '@typescript-eslint/no-base-to-string': 'error',
      // A union switch must name every member: a default that swallows a new
      // enum member is how a new provider silently no-ops through cost and
      // storage paths.
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
    },
  },
  {
    // Every TypeScript extension accepted by the source graph keeps the CLI
    // and shared layers outside the API-owned Azure SDK runtime boundary.
    files: [
      'src/cli/**/*.{ts,tsx,mts,cts}',
      'src/shared/**/*.{ts,tsx,mts,cts}',
    ],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@azure/*'],
              allowTypeImports: true,
              message:
                'CLI credential workflows must use their owned semantic transports; Azure SDK clients belong in the API provider boundary.',
            },
          ],
        },
      ],
    },
  },
  {
    // Typed linting for the CLI and shared layers exists (so far) for the
    // exhaustiveness rule alone; src/api's other typed rules are not widened
    // here.
    files: ['src/cli/**/*.ts', 'src/shared/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
    },
  },
  {
    // Use cases return results and renderers return lines; their command
    // adapters own terminal I/O and process exit. Imports are restricted in
    // .dependency-cruiser.cjs.
    files: [
      'src/cli/{use-cases,renderers}/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}',
    ],
    rules: {
      'no-console': 'error',
      // No other src/cli override configures the core rule, so these options
      // replace nothing; the Azure SDK ban uses the typescript-eslint variant.
      'no-restricted-imports': [
        'error',
        ...['process', 'node:process'].map((name) => ({
          name,
          message:
            'CLI use cases and renderers return values; the command adapter owns process state and terminal I/O.',
        })),
      ],
      'no-restricted-properties': [
        'error',
        ...['exit', 'exitCode', 'stdout', 'stderr', 'stdin', 'chdir'].map(
          (property) => ({
            object: 'process',
            property,
            message:
              'CLI use cases and renderers return values; the command adapter owns process state and terminal I/O.',
          }),
        ),
      ],
    },
  },
  {
    files: ['src/api/**/*.ts'],
    rules: {
      'local/environment-access-ownership': ['error', environmentAccessOptions],
      'local/no-uncontracted-api-routes': [
        'error',
        { allowedFiles: expressRouteOwnerFiles },
      ],
    },
  },
  {
    files: [
      'src/api/config.ts',
      'src/api/server.ts',
      'src/api/routes/**/*.ts',
      'src/api/services/workload-admission-*.ts',
    ],
    linterOptions: {
      noInlineConfig: true,
      reportUnusedDisableDirectives: true,
    },
  },
  {
    files: ['src/cli/services/credential-bootstrap/azure.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'child_process',
                'node:child_process',
                '**/slurp/cli-exec.js',
                '**/azure-cli-runner.js',
              ],
              message:
                'Azure generation must execute processes through azure-transport.ts and its owned argument runner.',
            },
          ],
        },
      ],
    },
  },
  {
    files: providerRuntimeFiles,
    ignores: providerRuntimeTestModeExceptions,
    rules: {
      'local/no-test-mode-in-provider-runtime': 'error',
    },
  },
  eslintConfigPrettier,
);
