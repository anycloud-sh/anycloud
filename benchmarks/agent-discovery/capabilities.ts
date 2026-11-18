import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  claudeTools,
  codexDisabledFeatures,
  codexSetupFeatures,
  type Condition,
  type SessionCondition,
} from './cases.ts';

/** Validate a Claude Code init event; a successful completion alone is insufficient. */
export function claudeCapabilityError(
  events: Record<string, unknown>[],
  condition: SessionCondition,
  plugin: string,
): string | null {
  const init = events.find(
    (event) => event.type === 'system' && event.subtype === 'init',
  );
  if (!init) return 'Missing runtime initialization event.';
  // The developer's subscription token reports no API key source; an API key or
  // apiKeyHelper from inherited settings would name one.
  if (init.apiKeySource !== 'none')
    return 'Runtime used an unexpected authentication source.';
  const tools = init.tools;
  const allowed = claudeTools(condition);
  const required = allowed.filter(
    (tool) => tool !== 'Skill' || condition === 'skill',
  );
  if (!Array.isArray(tools) || required.some((tool) => !tools.includes(tool)))
    return 'Runtime omitted required tools for the condition.';
  if (tools.some((tool) => !allowed.includes(tool)))
    return 'Runtime exposed tools outside the condition allowlist.';
  if (!Array.isArray(init.mcp_servers) || init.mcp_servers.length)
    return 'Runtime exposed unexpected MCP integrations.';
  if (!Array.isArray(init.skills)) return 'Runtime omitted skill metadata.';
  if (
    condition === 'skill'
      ? !init.skills.includes('anycloud:anycloud')
      : init.skills.length !== 0
  )
    return 'Runtime skill metadata does not match the condition.';
  if (!Array.isArray(init.plugins)) return 'Runtime omitted plugin metadata.';
  const external = init.plugins.filter((entry) => entry.path !== 'builtin');
  if (condition === 'skill') {
    if (
      external.length !== 1 ||
      external[0].name !== 'anycloud' ||
      external[0].path !== plugin
    )
      return 'Runtime did not load exactly the intended external plugin.';
  } else if (external.length) return 'Control loaded an external plugin.';
  return null;
}

function codexTurnError(events: Record<string, unknown>[]): string | null {
  if (
    !events.some((event) => event.type === 'thread.started') ||
    !events.some((event) => event.type === 'turn.completed')
  )
    return 'Missing initialized or completed Codex turn.';
  if (
    events.some(
      (event) =>
        event.type === 'error' ||
        (event.item as { type?: string } | undefined)?.type === 'error',
    )
  )
    return 'Codex reported a runtime error.';
  return null;
}

/**
 * Validate a Codex `setup` session from `codex features list` output and its
 * events: the shell is on, every other inherited integration is off, and the
 * turn completed without MCP calls.
 */
export function codexSetupCapabilityError(
  features: string,
  events: Record<string, unknown>[],
): string | null {
  for (const feature of codexDisabledFeatures) {
    const on = codexSetupFeatures.includes(feature);
    if (!new RegExp(`^${feature}\\s+[^\\n]*\\s${on}$`, 'm').test(features))
      return `Runtime feature ${feature} is not ${on ? 'enabled' : 'disabled'}.`;
  }
  if (
    events.some(
      (event) =>
        (event.item as { type?: string } | undefined)?.type === 'mcp_tool_call',
    )
  )
    return 'Runtime called an MCP tool.';
  return codexTurnError(events);
}

/** Validate recorded Codex sandbox evidence; successful completion alone is insufficient. */
export function codexCapabilityError(
  evidence: string,
  events: Record<string, unknown>[],
  condition: Condition,
  model: string,
  skillSha256: string,
): string | null {
  const features = readFileSync(path.join(evidence, 'features.txt'), 'utf8');
  if (
    codexDisabledFeatures.some(
      (feature) =>
        !new RegExp(`^${feature}\\s+[^\\n]*\\sfalse$`, 'm').test(features),
    )
  )
    return 'Runtime did not disable execution, mutation, or inherited integration features.';
  if (!/^code_mode_host\s+[^\n]*\strue$/m.test(features))
    return 'Runtime omitted the read-only tool dispatcher.';
  const originalModels = JSON.parse(
    readFileSync(path.join(evidence, 'models-original.json'), 'utf8'),
  );
  const restrictedModels = JSON.parse(
    readFileSync(path.join(evidence, 'models-readonly.json'), 'utf8'),
  );
  const expectedModels = {
    ...originalModels,
    models: originalModels.models.map((entry: Record<string, unknown>) => ({
      ...entry,
      apply_patch_tool_type: null,
    })),
  };
  if (JSON.stringify(restrictedModels) !== JSON.stringify(expectedModels))
    return 'Runtime changed model metadata beyond removing the patch tool.';
  const effectiveModels = JSON.parse(
    readFileSync(path.join(evidence, 'models.json'), 'utf8'),
  );
  if (
    effectiveModels.models.find(
      (entry: { slug: string }) => entry.slug === model,
    )?.apply_patch_tool_type !== null
  )
    return 'Runtime advertised an editing tool.';
  const config = readFileSync(path.join(evidence, 'config.toml'), 'utf8');
  if (
    !config.includes('web_search = "live"') ||
    !config.includes('sandbox_mode = "read-only"')
  )
    return 'Runtime omitted live research or read-only policy.';
  const servers = [...config.matchAll(/^\[mcp_servers\.([^\].]+)\]/gm)].map(
    (match) => match[1],
  );
  if (
    servers.length !== 1 ||
    servers.some((server) => server !== 'benchmark_readonly')
  )
    return 'Runtime exposed an unexpected MCP integration.';
  const prompt = JSON.parse(
    readFileSync(path.join(evidence, 'prompt-input.json'), 'utf8'),
  ) as { role?: string; content?: { text?: string }[] }[];
  const advertisedSkill = prompt
    .filter((item) => item.role === 'developer')
    .flatMap((item) => item.content ?? [])
    .some((item) => item.text?.includes('/skills/anycloud/SKILL.md'));
  if (advertisedSkill !== (condition === 'skill'))
    return 'Model-visible skill context does not match the condition.';
  const turnError = codexTurnError(events);
  if (turnError) return turnError;
  for (const event of events) {
    const item = event.item as
      | { type?: string; server?: string; tool?: string }
      | undefined;
    if (item?.type === 'command_execution' || item?.type === 'file_change')
      return 'Runtime executed a command or changed files.';
    if (
      item?.type === 'mcp_tool_call' &&
      !(item.server === 'benchmark_readonly' && item.tool === 'read_file') &&
      !(
        item.server === 'codex' &&
        [
          'list_mcp_resources',
          'list_mcp_resource_templates',
          'read_mcp_resource',
        ].includes(item.tool ?? '')
      )
    )
      return 'Runtime called an unexpected MCP tool.';
  }
  const rollouts: Record<string, unknown>[] = [];
  function collect(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) collect(file);
      else if (entry.name.endsWith('.jsonl'))
        rollouts.push(
          ...readFileSync(file, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line)),
        );
    }
  }
  collect(path.join(evidence, 'sessions'));
  const turns = rollouts.filter((event) => event.type === 'turn_context');
  if (
    !turns.length ||
    turns.some((event) => (event.payload as { model?: string }).model !== model)
  )
    return 'Recorded model does not match the requested comparison model.';
  // A skill read is scoring evidence, not required for a valid execution. Verify its content when present.
  for (const event of rollouts) {
    const call = event.payload as {
      type?: string;
      name?: string;
      input?: string;
    };
    if (
      event.type === 'response_item' &&
      ['function_call', 'custom_tool_call'].includes(call.type ?? '')
    ) {
      if (
        /exec_command|shell_command|apply_patch|spawn_agent/.test(
          call.name ?? '',
        ) ||
        /tools\.(?:exec_command|shell_command|apply_patch|spawn_agent)\s*\(/.test(
          call.input ?? '',
        )
      )
        return 'Rollout attempted an execution or mutation tool.';
    }
    if (
      JSON.stringify(event).includes('MCP tool call requires approval') ||
      JSON.stringify(event).includes('code-mode host is disabled')
    )
      return 'Runtime could not dispatch its read-only tools.';
  }
  const runtime = JSON.parse(
    readFileSync(path.join(evidence, 'runtime.json'), 'utf8'),
  );
  if (
    runtime.home !== '/home/agent/benchmark/home' ||
    runtime.inferenceProvider !== 'sandboxd'
  )
    return 'Unexpected home or inference authentication provider.';
  if (
    condition === 'skill'
      ? runtime.skillInstalledSha256 !== skillSha256
      : runtime.skillInstalledSha256 !== null
  )
    return 'Installed native skill does not match the snapshot or condition.';
  const snapshot = readFileSync(path.join(evidence, '..', 'skill-snapshot.md'));
  // The manifest binds copied native skill bytes to the baseline or updated snapshot.
  if (createHash('sha256').update(snapshot).digest('hex') !== skillSha256)
    return 'Missing skill snapshot identity.';
  return null;
}
