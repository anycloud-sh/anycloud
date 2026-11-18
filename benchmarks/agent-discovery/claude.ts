import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { claudeCapabilityError } from './capabilities.ts';
import { claudeArguments, type Condition } from './cases.ts';

interface Run {
  id: string;
  condition: Condition;
  prompt: string;
}

/**
 * Run each session in a fresh temporary HOME and config directory. The only
 * credential passed is the developer's subscription token from
 * `claude setup-token`; personal login, settings and API keys stay outside.
 */
export function runClaude(
  output: string,
  runs: Run[],
  pluginSource: string,
  token: string,
): (string | null)[] {
  const version = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  if (version.status !== 0)
    throw new Error('Claude CLI must be installed and runnable.');
  writeFileSync(path.join(output, 'claude-version.txt'), version.stdout);
  return runs.map((run) => {
    const evidence = path.join(output, run.id);
    mkdirSync(evidence);
    const isolated = mkdtempSync(path.join(tmpdir(), 'agent-discovery-'));
    try {
      const plugin = path.join(isolated, 'plugin');
      if (run.condition === 'skill') {
        mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true });
        mkdirSync(path.join(plugin, 'skills/anycloud'), { recursive: true });
        copyFileSync(
          path.join(pluginSource, '.claude-plugin/plugin.json'),
          path.join(plugin, '.claude-plugin/plugin.json'),
        );
        copyFileSync(
          path.join(output, 'skill-snapshot.md'),
          path.join(plugin, 'skills/anycloud/SKILL.md'),
        );
      }
      const args = claudeArguments(run.condition, plugin);
      const home = path.join(isolated, 'home');
      mkdirSync(home);
      const result = spawnSync('claude', args, {
        cwd: isolated,
        input: run.prompt,
        encoding: 'utf8',
        timeout: 300_000,
        maxBuffer: 16 * 1024 * 1024,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          XDG_CONFIG_HOME: path.join(home, 'config'),
          XDG_CACHE_HOME: path.join(home, 'cache'),
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          CLAUDE_CODE_OAUTH_TOKEN: token,
          CLAUDE_CONFIG_DIR: path.join(isolated, 'config'),
        },
      });
      writeFileSync(
        path.join(evidence, 'transcript.jsonl'),
        result.stdout || '',
      );
      writeFileSync(path.join(evidence, 'stderr.txt'), result.stderr || '');
      let error: string | null;
      let events: Record<string, unknown>[] = [];
      try {
        events = (result.stdout || '')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        error = claudeCapabilityError(events, run.condition, plugin);
      } catch {
        error = 'Malformed runtime transcript.';
      }
      const completion = events.findLast((event) => event.type === 'result');
      if (result.error) error ??= result.error.message;
      else if (result.status !== 0) error ??= `Claude exited ${result.status}`;
      else if (!completion || completion.is_error)
        error ??= 'Claude did not complete the turn.';
      writeFileSync(
        path.join(evidence, 'execution.json'),
        `${JSON.stringify({ args, exitCode: result.status, signal: result.signal, error }, null, 2)}\n`,
      );
      return error;
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });
}
