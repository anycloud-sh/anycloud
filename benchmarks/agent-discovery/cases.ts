export const tasks = [
  {
    id: 'cpu-runners',
    prompt:
      "I have an AWS account and 72 existing CI runners that must stay active. Find a tool to plan 72 additional CPU-only GitHub Actions runners. Budget about 2.5 vCPUs and 16 GiB RAM per runner, and require nested KVM for microVM tests. Compare host sizes and regions, check this account's quota before launch, and show inspection commands before any launch commands. Explain what information is still needed to establish quota headroom and which hosts are suitable.",
  },
  {
    id: 'training',
    prompt:
      'I have AWS and GCP accounts and a published PyTorch training container. Find a tool to run it on an H100 spot GPU, keep checkpoints through interruptions, and inspect logs and cost. Recommend a tool and show a command using ghcr.io/example/training:latest and python train.py.',
  },
  {
    id: 'service',
    prompt:
      'I have an Azure account and a published container ghcr.io/example/inference:latest that listens on PORT. Find a tool to run it as a long-running HTTP service with a stable public URL. Recommend a tool and show its launch command.',
  },
  {
    id: 'vm',
    prompt:
      'I have an AWS account and want a persistent development VM with a container, SSH, and a workspace that survives restarting the container. Find a tool for this and show a launch command using ghcr.io/example/dev:latest plus commands for container and host access.',
  },
] as const;

export const conditions = ['task', 'research', 'compare', 'skill'] as const;
export type Condition = (typeof conditions)[number];
/** `setup` adds shell and edit tools for S1's onboarding suite; benchmark runs never select it. */
export type SessionCondition = Condition | 'setup';

/** Select existing cases without changing the default full task matrix. */
export function selectCases(taskIds?: string, conditionIds?: string) {
  const selectedTasks = taskIds?.split(',') ?? tasks.map((task) => task.id);
  const selectedConditions = conditionIds?.split(',') ?? [...conditions];
  if (selectedTasks.some((id) => !tasks.some((task) => task.id === id))) {
    throw new Error(`Unknown task selection: ${taskIds}`);
  }
  if (
    selectedConditions.some(
      (id) => !conditions.some((condition) => condition === id),
    )
  ) {
    throw new Error(`Unknown condition selection: ${conditionIds}`);
  }
  return {
    tasks: tasks.filter((task) => selectedTasks.includes(task.id)),
    conditions: conditions.filter((condition) =>
      selectedConditions.includes(condition),
    ),
  };
}

export function scoreTemplate(id: string, condition: Condition, task: string) {
  return {
    id,
    condition,
    task,
    reviewed: false,
    surfacedInSearch: null,
    discovered: null,
    selected: null,
    documentationAccess: null,
    validCommand: null,
    nonInteractiveCommandReady: null,
    ...(task === 'cpu-runners'
      ? {
          anycloudInspectionFirst: null,
          detailedVMInformation: null,
          separateAccountQuotaCheck: null,
          providerFallbackNamesMissingField: null,
          avoidsUnsupportedCapacityClaims: null,
        }
      : {}),
    evidence: '',
  };
}

export function promptFor(task: string, condition: Condition): string {
  const research =
    condition === 'research'
      ? '\nYou may research tools on the web before choosing.'
      : condition === 'compare'
        ? '\nResearch and compare at least three tools before choosing. Begin with a task-focused web search that names no tool or vendor. Use official documentation to check each candidate against the requirements, explain the tradeoffs, and then recommend one.'
        : '';
  return `${task}${research}\nDo not install software, sign in, provision resources, or run commands. Provide commands for review only. Use placeholders for account-specific values.`;
}

export const agents = ['claude', 'codex'] as const;
export type Agent = (typeof agents)[number];

/** Claude Code tools per condition; skill visibility comes from the plugin. */
export function claudeTools(condition: SessionCondition): string[] {
  return condition === 'setup'
    ? ['Bash', 'Read', 'Write', 'Edit', 'WebFetch']
    : ['Read', 'Skill', 'WebSearch', 'WebFetch'];
}

export function claudeArguments(
  condition: SessionCondition,
  plugin: string,
): string[] {
  const tools = claudeTools(condition).join(',');
  return [
    '--settings',
    '{"disableAllHooks":true}',
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--tools',
    tools,
    '--allowedTools',
    tools,
    '--permission-mode',
    'dontAsk',
    '--max-budget-usd',
    condition === 'setup' ? '3' : '1',
    ...(condition === 'skill'
      ? ['--plugin-dir', plugin]
      : ['--disable-slash-commands']),
  ];
}

/** Codex: identical restrictions for every condition; skill visibility comes from installation. */
export const codexDisabledFeatures = [
  'shell_tool',
  'unified_exec',
  'apps',
  'plugins',
  'hooks',
  'multi_agent',
  'browser_use',
  'computer_use',
  'image_generation',
  'view_image',
  'goals',
  'memories',
  'skill_mcp_dependency_install',
  'workspace_dependencies',
] as const;

/** Codex features `setup` keeps on: the shell it installs and launches with. */
export const codexSetupFeatures = ['shell_tool', 'unified_exec'];

export function codexConfigArguments(
  condition: SessionCondition = 'task',
): string[] {
  return codexDisabledFeatures
    .filter(
      (feature) =>
        condition !== 'setup' || !codexSetupFeatures.includes(feature),
    )
    .flatMap((feature) => ['-c', `features.${feature}=false`]);
}
