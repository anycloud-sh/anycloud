import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexCapabilityError } from './capabilities.ts';
import { codexConfigArguments, type Condition } from './cases.ts';

const directory = path.dirname(fileURLToPath(import.meta.url));
/** The October 2026 pilot's immutable template; trials never pull another. */
export const codexTemplate =
  'docker/sandbox-templates@sha256:8b4cd0a46c8b600bc6b6a64af23c03d4c2807fbfc61f47568092a93fb9dc88b0';

interface Run {
  id: string;
  condition: Condition;
  prompt: string;
}

/**
 * Run each session in a fresh, mountless Docker Sandboxes (sbx) microVM. Codex
 * authenticates through the sandbox's own inference proxy, so no host login or
 * API key enters the sandbox.
 */
export function runCodex(
  output: string,
  runs: Run[],
  model: string,
  skillSha256: string,
): (string | null)[] {
  const version = spawnSync('sbx', ['version'], { encoding: 'utf8' });
  if (version.status !== 0)
    throw new Error(
      'Docker Sandboxes (sbx) must be installed and authenticated.',
    );
  writeFileSync(path.join(output, 'sandbox-version.txt'), version.stdout);
  return runs.map((run) => {
    const sandbox = `discovery-${randomUUID().slice(0, 12)}`;
    const evidence = path.join(output, run.id);
    mkdirSync(evidence);
    let exitCode: number | null = null;
    let error: string | null = null;
    const sbx = (args: string[], timeout = 60_000) => {
      const result = spawnSync('sbx', args, {
        encoding: 'utf8',
        timeout,
        maxBuffer: 32 * 1024 * 1024,
      });
      if (result.status !== 0)
        throw new Error(
          `sbx ${args[0]} failed: ${result.error?.message ?? result.stderr}`,
        );
      return result.stdout;
    };
    try {
      writeFileSync(
        path.join(evidence, 'create.txt'),
        sbx(
          [
            'create',
            '--name',
            sandbox,
            '--skills',
            'off',
            '--cpus',
            '2',
            '--memory',
            '2g',
            '--pull',
            'never',
            '--template',
            codexTemplate,
            'codex',
          ],
          180_000,
        ),
      );
      const sandboxInfo = JSON.parse(sbx(['ls', '--json'])).sandboxes.find(
        (entry: { name: string }) => entry.name === sandbox,
      );
      writeFileSync(
        path.join(evidence, 'sandbox.json'),
        JSON.stringify(sandboxInfo, null, 2),
      );
      // Explicitly omit PATH arguments from create: no host workspace mounts.
      for (const [source, target] of [
        [path.join(directory, 'bootstrap.mjs'), '/opt/bootstrap.mjs'],
        [path.join(directory, 'readonly-tools.py'), '/opt/readonly-tools.py'],
        [path.join(output, `${run.id}.prompt.txt`), '/opt/prompt.txt'],
      ])
        sbx(['cp', source, `${sandbox}:${target}`]);
      if (run.condition === 'skill')
        sbx([
          'cp',
          path.join(output, 'skill-snapshot.md'),
          `${sandbox}:/opt/anycloud-SKILL.md`,
        ]);
      const configArgs = codexConfigArguments();
      const settingsFile = path.join(evidence, 'settings.json');
      writeFileSync(settingsFile, JSON.stringify({ configArgs }));
      sbx(['cp', settingsFile, `${sandbox}:/opt/settings.json`]);
      sbx(['exec', sandbox, 'node', '/opt/bootstrap.mjs']);
      const environment = [
        'exec',
        '-e',
        'HOME=/home/agent/benchmark/home',
        '-e',
        'CODEX_HOME=/home/agent/benchmark/home/.codex',
        '-w',
        '/home/agent/benchmark/work',
        sandbox,
      ];
      // Record a genuine model-catalog response; do not silently accept fallback metadata.
      const models = sbx([...environment, 'codex', 'debug', 'models']);
      writeFileSync(path.join(evidence, 'models.json'), models);
      const selectedModel = JSON.parse(models).models.find(
        (entry: { slug: string }) => entry.slug === model,
      );
      if (!selectedModel)
        throw new Error(`Model ${model} is not advertised by this runtime.`);
      if (
        selectedModel.use_responses_lite ||
        !selectedModel.web_search_tool_type
      )
        throw new Error(
          'This template/model does not expose hosted web research. Choose an advertised non-Lite model, such as gpt-5.5.',
        );
      const result = spawnSync(
        'sbx',
        [
          ...environment,
          'codex',
          'exec',
          '--skip-git-repo-check',
          '--json',
          '-m',
          model,
          '-c',
          'model_reasoning_effort="medium"',
          ...configArgs,
          run.prompt,
        ],
        { encoding: 'utf8', timeout: 300_000, maxBuffer: 32 * 1024 * 1024 },
      );
      exitCode = result.status;
      writeFileSync(
        path.join(evidence, 'transcript.jsonl'),
        result.stdout || '',
      );
      writeFileSync(path.join(evidence, 'stderr.txt'), result.stderr || '');
      if (result.status !== 0)
        error = result.error?.message ?? `Codex exited ${result.status}`;
      sbx(['cp', `${sandbox}:/home/agent/benchmark/evidence/.`, evidence]);
      sbx([
        'cp',
        `${sandbox}:/home/agent/benchmark/home/.codex/sessions`,
        path.join(evidence, 'sessions'),
      ]);
      const events = (result.stdout || '')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      error ??= codexCapabilityError(
        evidence,
        events,
        run.condition,
        model,
        skillSha256,
      );
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      const cleanup = spawnSync('sbx', ['rm', '--force', sandbox], {
        encoding: 'utf8',
        timeout: 60_000,
      });
      writeFileSync(
        path.join(evidence, 'cleanup.txt'),
        `${cleanup.stdout || ''}${cleanup.stderr || ''}`,
      );
      if (cleanup.status !== 0) error ??= 'Sandbox cleanup failed.';
    }
    writeFileSync(
      path.join(evidence, 'execution.json'),
      `${JSON.stringify({ sandbox, exitCode, error }, null, 2)}\n`,
    );
    return error;
  });
}
