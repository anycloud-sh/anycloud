/**
 * Whole-graph module boundaries, checked by dependency-cruiser via
 * `yarn check:graph` (part of `yarn check:boundaries`).
 *
 * These rules carry the semantics of the retired eslint-plugin-local rules
 * `restricted-module-access`, `module-import-ownership`,
 * `dependency-free-module`, and `no-raw-db-imports`. Dependency-cruiser only
 * follows statically declared module specifiers; the companion ESLint rule
 * `local/literal-module-loads` rejects dynamic loads, loader capabilities, and
 * off-graph URL schemes, so nothing can leave this graph unseen.
 */

const escapeForRegExp = (path) => path.replaceAll('.', '\\.');
const exactPaths = (paths) => `^(${paths.map(escapeForRegExp).join('|')})$`;

// Implementation-owned modules and the only files allowed to import them.
// One dependency-cruiser rule is generated per owned module.
const localSmolvmRuntimeOwnership = [
  {
    file: 'src/api/services/gateways/local-smolvm-runtime.ts',
    allowedFiles: [
      'src/api/services/gateways/local.ts',
      'scripts/ci/cleanup-local-smolvm-runtime.ts',
      'test/integration/local-smolvm-runtime.spec.ts',
    ],
  },
];

const workloadAdmissionDomainFile =
  'src/api/services/workload-admission-domain.ts';
const workloadAdmissionPlanFile = 'src/api/services/workload-admission-plan.ts';
const workloadAdmissionPersistenceFile =
  'src/api/services/workload-admission-persistence.ts';
const workloadAdmissionOwnership = [
  {
    file: 'src/api/services/workload-admission-resolution.ts',
    allowedFiles: ['src/api/composition.ts'],
    typeOnlyFiles: [workloadAdmissionDomainFile, workloadAdmissionPlanFile],
  },
  {
    file: workloadAdmissionPlanFile,
    allowedFiles: ['src/api/composition.ts'],
    typeOnlyFiles: [
      workloadAdmissionDomainFile,
      workloadAdmissionPersistenceFile,
    ],
  },
  {
    file: workloadAdmissionPersistenceFile,
    allowedFiles: ['src/api/composition.ts'],
  },
  {
    file: 'src/api/services/workload-admission-writer.ts',
    allowedFiles: [workloadAdmissionPersistenceFile],
  },
  {
    file: 'src/api/services/workload-bucket-validation.ts',
    allowedFiles: [
      workloadAdmissionPlanFile,
      'src/api/services/repositories/workload-creation.ts',
      'src/api/services/pool-job-storage.ts',
    ],
  },
];

// Background monitor bodies extracted from monitor.ts; only its composition
// schedules them.
const backgroundMonitorOwnership = [
  'src/api/services/notifications-digest.ts',
  'src/api/services/cost-calculation/monitor.ts',
].map((file) => ({ file, allowedFiles: ['src/api/services/monitor.ts'] }));

const retryRecoveryWorkflowFile =
  'src/api/services/workload-workflows/retry-recovery.ts';
const completionWorkflowFile =
  'src/api/services/workload-workflows/completion.ts';
const completionReconcileFile =
  'src/api/services/workload-workflows/completion-reconcile.ts';
const vmHostStartupWorkflowFile =
  'src/api/services/workload-workflows/vm-host-startup.ts';
const hostStartupFile = 'src/api/services/host-runtime/host-startup.ts';
const persistentVmRepairFile =
  'src/api/services/workload-workflows/persistent-vm-repair.ts';
const vmContainerRepairFile =
  'src/api/services/host-runtime/vm-container-repair.ts';
const workloadPipelineFile =
  'src/api/services/workload-workflows/workload-pipeline.ts';
const workloadLifecycleOwnership = [
  {
    file: 'src/api/services/repositories/workload-lifecycle.ts',
    allowedFiles: [
      'src/api/services/persistence.ts',
      'src/api/services/repositories/deployment-executions.ts',
      'src/api/services/repositories/targeted-job-creation.ts',
      'src/api/services/repositories/workload-attempts.ts',
      'src/api/services/repositories/workload-outcomes.ts',
    ],
    typeOnlyFiles: [
      'src/api/services/serve/runtime.ts',
      'src/api/services/workload-reconciler.ts',
      retryRecoveryWorkflowFile,
    ],
  },
  {
    // The one attempt writer (RFC 0044): only attempt owners call it.
    file: 'src/api/services/repositories/workload-attempts.ts',
    allowedFiles: ['src/api/services/repositories/deployment-executions.ts'],
    typeOnlyFiles: ['src/api/services/deployment-workload-domain.ts'],
  },
  {
    file: 'src/api/services/repositories/workload-outcomes.ts',
    allowedFiles: [
      'src/api/services/persistence.ts',
      'src/api/services/repositories/deployment-executions.ts',
      'src/api/services/repositories/workload-queries.ts',
    ],
  },
  {
    file: 'src/api/services/repositories/provisioning-attempts.ts',
    allowedFiles: ['src/api/services/persistence.ts'],
    typeOnlyFiles: [
      'src/api/services/vm-release-notifications.ts',
      'src/api/services/repositories/workload-queries.ts',
      workloadPipelineFile,
    ],
  },
  {
    file: 'src/api/services/repositories/workload-events.ts',
    allowedFiles: ['src/api/composition.ts', 'src/api/services/persistence.ts'],
    typeOnlyFiles: [
      'src/api/services/workload-management-domain.ts',
      'src/api/services/repositories/workload-queries.ts',
    ],
  },
  {
    file: 'src/api/services/repositories/workload-queries.ts',
    allowedFiles: [
      'src/api/services/persistence.ts',
      'src/api/services/repositories/workload-spend.ts',
    ],
    typeOnlyFiles: [
      'src/api/services/repositories/deployment-executions.ts',
      'src/api/services/workload-management-domain.ts',
      'src/api/services/workload-reconciler.ts',
    ],
  },
  {
    file: 'src/api/services/notifications-digest-format.ts',
    allowedFiles: [
      'src/api/services/notifications-digest.ts',
      'src/api/services/notifications-digest-owners.ts',
    ],
  },
  {
    file: 'src/api/services/repositories/workload-spend.ts',
    allowedFiles: [
      'src/api/services/repositories/claim-spend-gate.ts',
      'src/api/services/notifications-digest-format.ts',
      'src/api/services/notifications-digest.ts',
      'src/api/services/persistence.ts',
      'src/api/services/spend-controls-store.ts',
    ],
  },
  // The admission writer is the only caller of the free upsertCredential.
  {
    file: 'src/api/services/repositories/credential-secrets.ts',
    allowedFiles: [
      'src/api/services/persistence.ts',
      'src/api/services/workload-admission-writer.ts',
    ],
  },
  // Likewise of the free createWorkload, which lives apart from the lifecycle
  // store because sibling repositories import that module's values.
  {
    file: 'src/api/services/repositories/workload-creation.ts',
    allowedFiles: ['src/api/services/workload-admission-writer.ts'],
    typeOnlyFiles: [
      workloadAdmissionPlanFile,
      workloadAdmissionPersistenceFile,
      'src/api/services/node-pool-service-admission.ts',
    ],
  },
  // Likewise of the free createTargetedWorkload; consumers take only types.
  {
    file: 'src/api/services/repositories/deployment-executions.ts',
    allowedFiles: [
      'src/api/services/persistence.ts',
      'src/api/services/workload-admission-writer.ts',
    ],
    typeOnlyFiles: [
      'src/api/services/deployment-controller.ts',
      'src/api/services/deployment-replicas.ts',
      'src/api/services/deployment-status.ts',
      'src/api/services/deployment-workload-domain.ts',
      'src/api/services/deployments-domain.ts',
      'src/api/services/targeted-job-admission.ts',
      workloadAdmissionPersistenceFile,
    ],
  },
  {
    file: 'src/api/services/repositories/node-pool-services.ts',
    allowedFiles: ['src/api/services/persistence.ts'],
    typeOnlyFiles: ['src/api/services/node-pool-service-reconciler.ts'],
  },
];

// Workload workflows and host-runtime effects extracted from monitor.ts,
// the retired conduct.ts and docker.ts.
const workloadWorkflowOwnership = [
  {
    file: retryRecoveryWorkflowFile,
    allowedFiles: ['src/api/services/monitor.ts', completionReconcileFile],
  },
  {
    file: 'src/api/services/host-runtime/vm-release-observer.ts',
    allowedFiles: [
      'src/api/services/monitor.ts',
      retryRecoveryWorkflowFile,
      completionReconcileFile,
      persistentVmRepairFile,
    ],
  },
  {
    file: 'src/api/services/workload-workflows/cleanup.ts',
    allowedFiles: ['src/api/services/monitor.ts'],
  },
  {
    file: 'src/api/services/host-runtime/termination.ts',
    allowedFiles: [
      'src/api/services/job/default-runtime.ts',
      'src/api/services/serve/default-runtime.ts',
      retryRecoveryWorkflowFile,
      completionWorkflowFile,
      vmHostStartupWorkflowFile,
    ],
  },
  {
    file: completionWorkflowFile,
    allowedFiles: [
      'src/api/services/job/default-runtime.ts',
      completionReconcileFile,
    ],
  },
  {
    file: completionReconcileFile,
    allowedFiles: ['src/api/services/monitor.ts'],
  },
  {
    file: vmHostStartupWorkflowFile,
    allowedFiles: [
      'src/api/services/job/default-runtime.ts',
      'src/api/services/serve/default-runtime.ts',
      'src/api/services/monitor.ts',
    ],
  },
  {
    file: hostStartupFile,
    allowedFiles: [vmContainerRepairFile, vmHostStartupWorkflowFile],
  },
  {
    file: 'src/api/services/host-runtime/image-delivery.ts',
    allowedFiles: [
      vmContainerRepairFile,
      hostStartupFile,
      // The live SmolVM qualification pulls through the real delivery path.
      'test/integration/helpers/vm-container-profile.ts',
    ],
  },
  {
    file: persistentVmRepairFile,
    allowedFiles: ['src/api/services/monitor.ts'],
  },
  {
    file: vmContainerRepairFile,
    allowedFiles: [persistentVmRepairFile],
  },
  {
    file: workloadPipelineFile,
    allowedFiles: [
      'src/api/services/monitor.ts',
      'src/api/services/workload-workflows/provisioning-scheduler.ts',
    ],
  },
  {
    file: 'src/api/services/workload-workflows/provisioning-scheduler.ts',
    allowedFiles: ['src/api/services/monitor.ts'],
  },
  {
    file: 'src/api/services/workload-workflows/targeted-job.ts',
    allowedFiles: ['src/api/services/monitor.ts'],
  },
  {
    file: 'src/api/services/credential-auth-failure.ts',
    allowedFiles: ['src/api/services/launch-targets.ts'],
  },
  {
    file: 'src/api/services/workload-admission-checks.ts',
    allowedFiles: [
      'src/api/composition.ts',
      'src/api/services/compute-validation.ts',
      workloadAdmissionPlanFile,
    ],
  },
];

const credentialOnboardingFacadeFile =
  'src/cli/services/credential-onboarding/index.ts';
const credentialAcquisitionFile =
  'src/cli/services/credential-onboarding/acquisition.ts';
const credentialDiscoveryFile =
  'src/cli/services/credential-onboarding/discovery.ts';
const credentialMaterializationFile =
  'src/cli/services/credential-onboarding/materialization.ts';
const azureCredentialBootstrapFile =
  'src/cli/services/credential-bootstrap/azure.ts';
const credentialOnboardingOwnership = [
  {
    file: credentialAcquisitionFile,
    allowedFiles: [credentialOnboardingFacadeFile],
  },
  {
    file: 'src/cli/services/credential-onboarding/acquired-credential.ts',
    allowedFiles: [credentialAcquisitionFile, credentialMaterializationFile],
    typeOnlyFiles: [credentialOnboardingFacadeFile],
  },
  {
    file: 'src/cli/services/credential-onboarding/credential-builders.ts',
    allowedFiles: [
      credentialOnboardingFacadeFile,
      credentialAcquisitionFile,
      credentialMaterializationFile,
    ],
  },
  {
    file: credentialDiscoveryFile,
    allowedFiles: [
      credentialOnboardingFacadeFile,
      credentialAcquisitionFile,
      credentialMaterializationFile,
    ],
  },
  {
    file: credentialMaterializationFile,
    allowedFiles: [credentialAcquisitionFile],
  },
  {
    file: 'src/cli/services/credential-onboarding/types.ts',
    allowedFiles: [],
    typeOnlyFiles: [
      credentialOnboardingFacadeFile,
      credentialAcquisitionFile,
      credentialDiscoveryFile,
      credentialMaterializationFile,
    ],
  },
  {
    file: 'src/cli/services/credential-onboarding/aws-validation.ts',
    allowedFiles: [credentialOnboardingFacadeFile],
  },
  {
    file: 'src/cli/services/credential-onboarding/gcp-key-files.ts',
    allowedFiles: [
      credentialOnboardingFacadeFile,
      credentialDiscoveryFile,
      credentialMaterializationFile,
      'src/cli/services/slurp/gcp.ts',
    ],
  },
  {
    file: azureCredentialBootstrapFile,
    allowedFiles: [credentialAcquisitionFile],
  },
  {
    file: 'src/cli/services/credential-bootstrap/aws.ts',
    allowedFiles: [credentialAcquisitionFile],
  },
  {
    file: 'src/cli/services/credential-bootstrap/aws-cli-runner.ts',
    allowedFiles: [
      credentialAcquisitionFile,
      'src/cli/services/credential-bootstrap/aws.ts',
    ],
  },
  {
    file: 'src/cli/services/credential-bootstrap/gcp.ts',
    allowedFiles: [credentialAcquisitionFile],
  },
  {
    file: 'src/cli/services/credential-bootstrap/gcp-cli-runner.ts',
    allowedFiles: [
      credentialAcquisitionFile,
      'src/cli/services/credential-bootstrap/gcp-transport.ts',
    ],
    typeOnlyFiles: ['src/cli/services/credential-bootstrap/gcp.ts'],
  },
  {
    file: 'src/cli/services/credential-bootstrap/gcp-transport.ts',
    allowedFiles: ['src/cli/services/credential-bootstrap/gcp.ts'],
  },
  {
    file: 'src/cli/services/slurp/aws.ts',
    allowedFiles: [
      credentialAcquisitionFile,
      credentialDiscoveryFile,
      credentialMaterializationFile,
    ],
  },
  {
    file: 'src/cli/services/slurp/azure.ts',
    allowedFiles: [credentialAcquisitionFile],
  },
  {
    file: 'src/cli/services/slurp/gcp.ts',
    allowedFiles: [credentialAcquisitionFile, credentialDiscoveryFile],
  },
  {
    file: 'src/cli/services/credential-onboarding/generated-credential-name.ts',
    allowedFiles: [credentialAcquisitionFile, azureCredentialBootstrapFile],
  },
];

const cliUseCaseOwnership = [
  {
    file: 'src/cli/use-cases/save-credential.ts',
    allowedFiles: ['src/cli/commands/credentials/new.ts'],
  },
  {
    file: 'src/cli/use-cases/quota-status.ts',
    allowedFiles: [
      'src/cli/commands/quota.ts',
      'src/cli/commands/quota-cloud.ts',
      'src/cli/renderers/quota-status.ts',
    ],
  },
  ...[
    'src/cli/renderers/quota-status.ts',
    'src/cli/prompts/quota-types.ts',
  ].map((file) => ({
    file,
    allowedFiles: [
      'src/cli/commands/quota.ts',
      'src/cli/commands/quota-cloud.ts',
    ],
  })),
  {
    file: 'src/cli/use-cases/workload-status.ts',
    allowedFiles: ['src/cli/commands/status.ts', 'src/cli/commands/wait.ts'],
    typeOnlyFiles: ['src/cli/renderers/workload-status.ts'],
  },
  {
    file: 'src/cli/renderers/workload-status.ts',
    allowedFiles: ['src/cli/commands/status.ts'],
  },
  {
    file: 'src/cli/use-cases/workload-wait.ts',
    allowedFiles: ['src/cli/commands/wait.ts'],
    typeOnlyFiles: ['src/cli/renderers/workload-wait.ts'],
  },
  {
    file: 'src/cli/renderers/workload-wait.ts',
    allowedFiles: ['src/cli/commands/wait.ts'],
  },
  {
    file: 'src/cli/use-cases/workload-list.ts',
    allowedFiles: [
      'src/cli/commands/list.ts',
      'src/cli/renderers/workload-list.ts',
    ],
  },
  ...[
    'src/cli/renderers/workload-list.ts',
    'src/cli/prompts/workload-list.ts',
  ].map((file) => ({ file, allowedFiles: ['src/cli/commands/list.ts'] })),
];

const mutationConfigurationOwnership = [
  {
    file: 'stryker.harness.config.mjs',
    allowedFiles: [
      'scripts/check-mutation-scope.mjs',
      'test/mutation/qualify-sandbox.mjs',
      'test/unit/scripts/check-mutation-scope.spec.mjs',
    ],
  },
  {
    file: 'vitest.mutation.config.mjs',
    allowedFiles: [
      'scripts/check-mutation-scope.mjs',
      'test/unit/scripts/check-mutation-scope.spec.mjs',
    ],
  },
];

// RFC 0047: the docs publish the AWS policy; in src/ only AWS generation and
// the role connection setup templates read it.
const publishedPolicyOwnership = [
  {
    file: 'src/shared/cloud-policies/aws-anycloud-access.json',
    allowedFiles: [
      'src/cli/services/credential-bootstrap/aws.ts',
      'src/api/services/role-connection-setup-templates.ts',
    ],
  }, // R2's S3 helpers stay on the Cloudflare credential, which the AnycloudAccess
  // drift scan skips; the AWS gateway may not reuse them.
  ...[
    'src/api/services/gateways/r2-objects.ts',
    'src/api/services/provider-clients/cloudflare.ts',
  ].map((file) => ({
    file,
    allowedFiles: ['src/api/services/gateways/cloudflare.ts'],
  })),
];

const ownedModules = [
  ...localSmolvmRuntimeOwnership,
  ...workloadAdmissionOwnership,
  ...backgroundMonitorOwnership,
  ...workloadLifecycleOwnership,
  ...workloadWorkflowOwnership,
  ...credentialOnboardingOwnership,
  ...cliUseCaseOwnership,
  ...mutationConfigurationOwnership,
  ...publishedPolicyOwnership,
];

const ownershipRules = ownedModules.flatMap(
  ({ file, allowedFiles, typeOnlyFiles = [] }) => {
    // Two path segments keep basenames like the aws.ts bootstrap/slurp pair
    // distinct; the load-time guard below makes a future collision loud.
    const name = `module-ownership:${file.split('/').slice(-2).join('.')}`;
    const to = { path: exactPaths([file]) };
    const rule = {
      name,
      comment: `${file} is implementation-owned and may only be imported by its configured owners.`,
      severity: 'error',
      from: { pathNot: exactPaths([...allowedFiles, ...typeOnlyFiles]) },
      to,
    };
    if (typeOnlyFiles.length === 0) return [rule];
    // The same erased-dependency labels as raw-db-access below.
    return [
      rule,
      {
        name: `${name}:types`,
        comment: `These consumers may import only types from ${file}.`,
        severity: 'error',
        from: { path: exactPaths(typeOnlyFiles) },
        to: {
          ...to,
          dependencyTypesNot: ['pre-compilation-only', 'type-import'],
        },
      },
    ];
  },
);
const ownershipRuleNames = ownershipRules.map((rule) => rule.name);
if (new Set(ownershipRuleNames).size !== ownershipRuleNames.length) {
  throw new Error(
    'module-ownership rule names collide; widen the path segments used to name them',
  );
}

// Any resolved local path with a segment in this set is out of bounds; a
// package specifier that happens to contain a segment (node_modules) is not.
const forbiddenForScripts = '(^|/)(experiments|test)/';

module.exports = {
  forbidden: [
    {
      name: 'ssh-process-helper-lightweight',
      comment:
        'The SSH process helper and its IPC contract must not load the API, persistence, or provider SDKs: their small address space bounds Linux fork cost.',
      severity: 'error',
      from: {
        path: '^src/api/services/gateways/ssh-process-(helper|protocol)\\.ts$',
      },
      to: {
        pathNot:
          '^src/api/services/gateways/ssh-process-protocol\\.ts$|^(birpc|execa|stream)$|^node_modules/(birpc|execa)/',
      },
    },
    {
      name: 'production-source-boundary',
      comment:
        'Production source loads only what its shipped artifacts carry: src/ (built to dist/), packages and package.json.',
      severity: 'error',
      // Resolved targets only: an unresolved package specifier (conditional
      // exports the resolver cannot follow) is not a repository path. An
      // earlier release shipped a src/ import of docs/ that crashed the API image's CLI.
      from: { path: '^src/' },
      to: {
        couldNotResolve: false,
        dependencyTypesNot: ['core'],
        pathNot: '^(src|node_modules)/|^package\\.json$',
      },
    },
    {
      name: 'script-boundary',
      comment: 'Repository scripts must not load test or experiment code.',
      severity: 'error',
      from: { path: '^scripts/' },
      to: {
        path: forbiddenForScripts,
        pathNot: '^node_modules/',
        couldNotResolve: false,
      },
    },
    {
      name: 'reconciliation-mechanism-boundary',
      comment:
        'Reconciliation mechanisms must not depend on application records or policy, including through type-only imports.',
      severity: 'error',
      from: { path: '^src/api/services/reconciliation/' },
      to: {
        path: '^src/',
        pathNot: '^src/api/services/reconciliation/',
      },
    },
    {
      // RFC 0044 invariant 17.
      name: 'substrate-neutral-core',
      comment:
        'The surface, Workload records, outcome policy and shared contracts are substrate-neutral: they import nothing under kubernetes/.',
      severity: 'error',
      from: {
        path: '^src/(cli/commands/|api/rpc/|shared/api-contract/|api/services/(repositories/|(workload-record|job-outcome|spend-controls[^/]*|deployment-(store|errors)|(cluster|node-pool)-errors)\\.ts$))',
      },
      to: { path: '^src/api/services/kubernetes/' },
    },
    {
      // RFC 0044 invariant 1, over the new Pod modules until PR 12 widens it
      // to all of kubernetes/; the four kubernetes/ modules that still import
      // product code are not allowed siblings.
      name: 'pool-substrate-boundary',
      comment:
        'The Pod substrate imports no Workload or Deployment record, domain, persistence or product policy; product concepts reach it as parameters.',
      severity: 'error',
      from: {
        path: '^src/api/services/kubernetes/(pod-termination|pool-objects|pod-logs|list-watch)\\.ts$',
      },
      to: {
        path: '^src/',
        pathNot:
          '^src/(shared/|api/services/(kubernetes/(?!(deployment-runtime|default-runtime)\\.ts$)|system-release/ingress\\.ts$|(cluster-store|job-outcome|request-budget|api-identity|network|entities|container-image|logger)\\.ts$))',
      },
    },
    {
      // RFC 0044: the composition root registers the owners.
      name: 'pool-loop-owner-boundary',
      comment:
        'The pool loop imports no owner, record or persistence; owners reach it through PoolOwner.',
      severity: 'error',
      from: { path: '^src/api/services/pool-reconciler\\.ts$' },
      to: {
        path: '^src/api/services/(deployment|node-pool-service|persistence|repositories/)',
      },
    },
    {
      name: 'pool-substrate-boundary:types',
      comment:
        'The Pod substrate takes only types from cluster-store and job-outcome (the Cause).',
      severity: 'error',
      from: {
        path: '^src/api/services/kubernetes/(pod-termination|pool-objects|pod-logs|list-watch)\\.ts$',
      },
      to: {
        path: '^src/api/services/(cluster-store|job-outcome)\\.ts$',
        dependencyTypesNot: ['pre-compilation-only', 'type-import'],
      },
    },
    {
      // RFC 0015 invariant 13.
      name: 'cloud-resource-boundary',
      comment:
        'Gateways may consume opaque resource scopes and generic network intent, but must not import cluster or Kubernetes lifecycle modules.',
      severity: 'error',
      from: { path: '^src/api/services/gateways/' },
      // Unlike the directory rules above, external packages stay in scope:
      // the retired script matched specifier text, and RFC 0015 does not
      // exempt external lifecycle modules from this boundary.
      to: {
        path: '(cluster-store|managed-cluster|managed-kubernetes|/kubernetes(/|\\.))',
      },
    },
    {
      name: 'gcp-sdk-clients',
      comment:
        'GCP SDK and auth clients are built only in provider-clients/gcp.ts, so every client made from the customer key is typed where the published role drift scan reads it; the catalog fetcher uses an operator key.',
      severity: 'error',
      from: {
        path: '^src/',
        pathNot:
          '^src/api/services/provider-clients/gcp\\.ts$|^src/shared/catalog/gcp\\.ts$',
      },
      to: {
        path: '(^|/)node_modules/(@google-cloud|google-auth-library|google-gax|gaxios|googleapis)/|^(@google-cloud/|(google-auth-library|google-gax|gaxios|googleapis)$)',
        dependencyTypesNot: ['pre-compilation-only', 'type-import'],
      },
    },
    {
      name: 'workload-workflow-boundary',
      comment:
        'Workload workflows receive persistence through their declared interfaces and reach clouds through the provider-neutral contract: no monitor composition, persistence root, raw database, provider gateway, provider client, or SDK.',
      severity: 'error',
      from: { path: '^src/api/services/workload-workflows/' },
      to: {
        path: '^src/api/services/(monitor|persistence|repositories/db)\\.ts$|^src/api/services/(gateways|provider-clients)/|(^|/)node_modules/(@aws-sdk|@azure|@google-cloud|@kubernetes|better-sqlite3)/|^(@aws-sdk|@azure|@google-cloud|@kubernetes|better-sqlite3)$|^(@aws-sdk|@azure|@google-cloud|@kubernetes)/',
        pathNot: '^src/api/services/gateways/cloud\\.ts$',
      },
    },
    {
      name: 'workload-effect-boundary',
      comment:
        'Host-runtime effects and repositories serve workflows; they must not import a workflow or the monitor.',
      severity: 'error',
      from: { path: '^src/api/services/(host-runtime|repositories)/' },
      to: {
        path: '^src/api/services/(workload-workflows/|monitor\\.ts$)',
      },
    },
    {
      name: 'long-history-probe-lightweight',
      comment:
        'The long-history probe entry runs under the six-second read budget, so it must load the store modules only — never the API or the monitor — and the budget measures the read models rather than the API module graph. Its recover and serve siblings have their own entries.',
      severity: 'error',
      from: {
        path: '^test/integration/e2e/internal/read-models/history-child\\.ts$',
      },
      to: {
        path: '^src/api/(server\\.ts|services/monitor\\.ts)$',
        reachable: true,
      },
    },
    {
      name: 'smolvm-contract-dependency-free',
      comment:
        'This shared contract must remain dependency-free; declare only immutable boundary facts here.',
      severity: 'error',
      from: { path: '^src/api/services/gateways/local-smolvm-contract\\.ts$' },
      to: {},
    },
    {
      name: 'raw-db-access',
      comment:
        'Raw database access is restricted to repository modules. Use the persistence or domain repository API instead.',
      severity: 'error',
      from: {
        path: '^src/api/',
        pathNot: [
          '^src/api/services/repositories/',
          '^src/api/services/workload-admission-writer\\.ts$',
          '^src/api/services/persistence\\.ts$',
        ],
      },
      // tsPreCompilationDeps 'specify' labels erased dependencies
      // pre-compilation-only; a mixed `import db, { type DB }` statement
      // emits at runtime and does not get the label, while pure
      // `import type` and type-position `import('...')` expressions do.
      // The coarser type-only label is shared by both and cannot be used.
      // Packages stay out of scope like the directory rules: the retired
      // rule ignored bare specifiers.
      to: {
        path: '(^|/)repositories/db(\\.ts)?$',
        pathNot: '^node_modules/',
        dependencyTypesNot: ['pre-compilation-only', 'type-import'],
        couldNotResolve: false,
      },
    },
    {
      name: 'cli-use-case-boundary',
      comment:
        'CLI use cases return results to their command adapters; terminal input and output belong to commands, prompts, and renderers.',
      severity: 'error',
      from: { path: '^src/cli/use-cases/' },
      to: {
        path: '^src/cli/(commands|prompts|renderers)/|^src/cli/utils/(output|safe-prompts)\\.ts$|(^|/)node_modules/(ora|chalk|prompts|cli-table3)/|^(ora|chalk|prompts|cli-table3)$',
      },
    },
    {
      name: 'cli-renderer-boundary',
      comment:
        'CLI renderers format results they are given; fetching, prompting, and printing belong to use cases, prompts, and commands.',
      severity: 'error',
      from: { path: '^src/cli/renderers/' },
      to: {
        path: '^src/cli/(commands|prompts|services)/|^src/cli/utils/(output|safe-prompts)\\.ts$|^src/shared/services/api-client/|(^|/)node_modules/(ora|prompts)/|^(ora|prompts)$',
      },
    },
    {
      name: 'cli-prompt-boundary',
      comment:
        'CLI prompts collect input; operations and output belong to use cases, renderers, and commands.',
      severity: 'error',
      from: { path: '^src/cli/prompts/' },
      to: {
        path: '^src/cli/(commands|renderers|use-cases)/|^src/cli/utils/output\\.ts$|^src/shared/services/api-client/',
      },
    },
    // One wrapper owns each terminal library, so TTY and colour handling
    // (chalk's decision) is applied in one place.
    ...[
      ['cli-table3', 'src/cli/renderers/table.ts'],
      ['ora', 'src/cli/utils/output.ts'],
      ['prompts', 'src/cli/utils/safe-prompts.ts'],
    ].map(([library, owner]) => ({
      name: `terminal-library-ownership:${library}`,
      comment: `${library} is wrapped by ${owner}; import the wrapper instead.`,
      severity: 'error',
      from: { path: '^src/', pathNot: exactPaths([owner]) },
      to: { path: `(^|/)node_modules/${library}/|^${library}$` },
    })),
    {
      name: 'unresolvable-local-import',
      comment:
        'An unresolved specifier that is not a bare package name — a relative or absolute path (typo, ?query/#hash suffix) or any URL scheme (file:, data:, https:) — would silently exempt its target from every boundary rule above.',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true, path: '^(\\.|/|#)|:' },
    },
    {
      name: 'unexpected-root',
      comment:
        'Resolved local modules must belong to known roots or exact configuration files with explicit consumers.',
      severity: 'error',
      // Discriminate on the resolver's own classification, not path shape:
      // a slash heuristic exempted root-level local files.
      from: {},
      to: {
        couldNotResolve: false,
        // Resolved absolute type-only imports classify as undetermined.
        dependencyTypes: ['local', 'undetermined'],
        pathNot:
          '^(node_modules|src|scripts|test|ci|benchmarks|experiments|\\.context)/|^(package\\.json|stryker\\.harness\\.config\\.mjs|vitest\\.mutation\\.config\\.mjs)$',
      },
    },
    // Written out with literal names so RFC 0027 invariant 2 can cite them;
    // the ledger validator reads rule names textually.
    {
      name: 'module-ownership:credential-bootstrap.azure-transport.ts',
      comment:
        'The Azure transaction is the sole consumer of its semantic transport.',
      severity: 'error',
      from: {
        pathNot: '^src/cli/services/credential-bootstrap/azure\\.ts$',
      },
      to: {
        path: '^src/cli/services/credential-bootstrap/azure-transport\\.ts$',
      },
    },
    {
      name: 'module-ownership:credential-bootstrap.azure-cli-runner.ts',
      comment:
        'The Azure transport is the sole consumer of the argument runner.',
      severity: 'error',
      from: {
        pathNot: '^src/cli/services/credential-bootstrap/azure-transport\\.ts$',
      },
      to: {
        path: '^src/cli/services/credential-bootstrap/azure-cli-runner\\.ts$',
      },
    },
    ...ownershipRules,
  ],
  options: {
    // Anchored to the directory: an unanchored pattern would also skip a
    // local file merely named to contain the substring
    // (src/node_modules-shim.ts), concealing its imports from every rule.
    doNotFollow: { path: '(^|/)node_modules/' },
    exoticRequireStrings: ['module.require'],
    tsPreCompilationDeps: 'specify',
    tsConfig: { fileName: 'tsconfig.json' },
  },
};
