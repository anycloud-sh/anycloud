import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  agents,
  promptFor,
  scoreTemplate,
  selectCases,
  type Agent,
} from './cases.ts';
import { runClaude } from './claude.ts';
import { codexTemplate, runCodex } from './codex.ts';

const usage =
  'Usage: yarn tsx benchmarks/agent-discovery/run.ts prepare|run <new-output-directory> [trials] --agent claude|codex [--tasks ids] [--conditions ids] [--plugin directory] [--model id]';
const directory = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(directory, '../..');
const [mode, outputArgument, ...options] = process.argv.slice(2);
const trialsArgument = options[0]?.startsWith('--')
  ? '1'
  : (options.shift() ?? '1');
let agent: string | undefined;
let taskIds: string | undefined;
let conditionIds: string | undefined;
let pluginSource = path.join(repository, 'anycloud-skills');
// Codex only: the model the pinned Docker Sandboxes template advertises.
let model = 'gpt-5.5';
for (let i = 0; i < options.length; i += 2) {
  const value = options[i + 1];
  if (!value) throw new Error(`Missing value for ${options[i]}`);
  if (options[i] === '--agent') agent = value;
  else if (options[i] === '--tasks') taskIds = value;
  else if (options[i] === '--conditions') conditionIds = value;
  else if (options[i] === '--plugin') pluginSource = path.resolve(value);
  else if (options[i] === '--model') model = value;
  else throw new Error(`Unknown option ${options[i]}`);
}
if (
  !['prepare', 'run'].includes(mode) ||
  !outputArgument ||
  !agents.includes(agent as Agent)
)
  throw new Error(usage);
const { tasks, conditions } = selectCases(taskIds, conditionIds);
const trials = Number(trialsArgument);
if (!Number.isInteger(trials) || trials < 1 || trials > 10)
  throw new Error('Trials must be an integer from 1 to 10.');
// Check credentials before creating evidence, so a rerun needs no cleanup.
const claudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
if (mode === 'run' && agent === 'claude' && !claudeToken)
  throw new Error(
    'Claude runs require CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`.',
  );
const output = path.resolve(outputArgument);
mkdirSync(output); // Refuse to overwrite earlier evidence.
const writeJson = (name: string, value: unknown) =>
  writeFileSync(path.join(output, name), `${JSON.stringify(value, null, 2)}\n`);
const runs = [];
for (let trial = 0; trial < trials; trial++) {
  for (const task of tasks) {
    // Rotate condition order between trials to reduce time/order bias.
    for (let offset = 0; offset < conditions.length; offset++) {
      const condition = conditions[(trial + offset) % conditions.length];
      const id = `${task.id}-${condition}-${trial + 1}`;
      const prompt = promptFor(task.prompt, condition);
      writeFileSync(path.join(output, `${id}.prompt.txt`), prompt);
      runs.push({ id, task: task.id, condition, prompt });
    }
  }
}
const revision = spawnSync('git', ['rev-parse', 'HEAD'], {
  cwd: repository,
  encoding: 'utf8',
});
if (revision.status !== 0) throw new Error('Cannot record source revision.');
const skill = readFileSync(path.join(pluginSource, 'skills/anycloud/SKILL.md'));
const skillSha256 = createHash('sha256').update(skill).digest('hex');
writeFileSync(path.join(output, 'skill-snapshot.md'), skill);
writeJson('manifest.json', {
  startedAt: new Date().toISOString(),
  revision: revision.stdout.trim(),
  harnessSha256: createHash('sha256')
    .update(
      [
        'run.ts',
        'cases.ts',
        'capabilities.ts',
        'claude.ts',
        'codex.ts',
        'bootstrap.mjs',
        'readonly-tools.py',
      ]
        .map((file) => readFileSync(path.join(directory, file), 'utf8'))
        .join('\n'),
    )
    .digest('hex'),
  agent,
  mode,
  trials,
  pluginSource,
  skillSha256,
  ...(agent === 'codex'
    ? { model, reasoningEffort: 'medium', template: codexTemplate }
    : { apiBudgetUsdPerSession: 1 }),
  timeoutMsPerSession: 300_000,
  runs,
});
writeJson(
  'scores.json',
  runs.map(({ id, condition, task }) => scoreTemplate(id, condition, task)),
);
if (mode === 'run') {
  const errors =
    agent === 'claude'
      ? runClaude(output, runs, pluginSource, claudeToken!)
      : runCodex(output, runs, model, skillSha256);
  runs.forEach((run, i) =>
    console.log(
      `${run.id}: ${errors[i] ?? 'completed; awaiting evidence review'}`,
    ),
  );
  // Failed runs keep their evidence and stay out of successful-run rates.
  if (errors.some(Boolean)) process.exitCode = 1;
}
console.log(
  `Evidence: ${output}. Review transcripts using README.md before filling scores.json.`,
);
