import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  claudeArguments,
  codexConfigArguments,
  codexDisabledFeatures,
  conditions,
  promptFor,
  tasks,
  selectCases,
  scoreTemplate,
} from '../../benchmarks/agent-discovery/cases.ts';
import {
  claudeCapabilityError,
  codexCapabilityError,
  codexSetupCapabilityError,
} from '../../benchmarks/agent-discovery/capabilities.ts';

describe('agent discovery benchmark', () => {
  it('selects the CPU regression and rejects invalid selectors', () => {
    const selected = selectCases('cpu-runners', 'task,skill');
    expect(selected.tasks.map((task) => task.id)).toEqual(['cpu-runners']);
    expect(selected.conditions).toEqual(['task', 'skill']);
    expect(() => selectCases('unknown')).toThrow('Unknown task');
    expect(() => selectCases(undefined, 'unknown')).toThrow(
      'Unknown condition',
    );
    expect(() => selectCases('')).toThrow('Unknown task');
  });

  it('leaves CPU-specific scores unreviewed and does not add them to other tasks', () => {
    const cpu = scoreTemplate('cpu-skill-1', 'skill', 'cpu-runners');
    expect(cpu).toMatchObject({
      reviewed: false,
      anycloudInspectionFirst: null,
      detailedVMInformation: null,
      separateAccountQuotaCheck: null,
      providerFallbackNamesMissingField: null,
      avoidsUnsupportedCapacityClaims: null,
    });
    expect(scoreTemplate('vm-task-1', 'task', 'vm')).not.toHaveProperty(
      'anycloudInspectionFirst',
    );
  });

  it('keeps natural prompts unbranded and adds explicit tool comparison', () => {
    for (const task of tasks) {
      for (const condition of conditions) {
        expect(promptFor(task.prompt, condition)).not.toMatch(
          /anycloud|skypilot|devpod|container apps/i,
        );
      }
      expect(promptFor(task.prompt, 'compare')).toContain(
        'at least three tools',
      );
      expect(promptFor(task.prompt, 'compare')).toContain(
        'names no tool or vendor',
      );
      expect(promptFor(task.prompt, 'skill')).toBe(
        promptFor(task.prompt, 'task'),
      );
      expect(promptFor(task.prompt, 'research')).toContain(
        'You may research tools',
      );
    }
  });

  it('disables Codex execution and inherited integrations identically for every condition', () => {
    const args = codexConfigArguments();
    for (const feature of codexDisabledFeatures)
      expect(args).toContain(`features.${feature}=false`);
    expect(codexDisabledFeatures).toContain('shell_tool');
    expect(codexDisabledFeatures).toContain('unified_exec');
    expect(codexDisabledFeatures).toContain('multi_agent');
  });

  it('validates Codex model-visible skill context, model identity, restrictions, and completed turns', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'discovery-capabilities-'));
    try {
      const evidence = path.join(root, 'session');
      mkdirSync(path.join(evidence, 'sessions'), { recursive: true });
      const skill = 'baseline skill bytes';
      writeFileSync(path.join(root, 'skill-snapshot.md'), skill);
      const hash = createHash('sha256').update(skill).digest('hex');
      writeFileSync(
        path.join(evidence, 'features.txt'),
        codexDisabledFeatures
          .map((feature) => `${feature} stable false`)
          .join('\n') + '\ncode_mode_host stable true',
      );
      const originalModels = {
        models: [
          {
            slug: 'test-model',
            apply_patch_tool_type: 'freeform',
            use_responses_lite: false,
            web_search_tool_type: 'text_and_image',
          },
        ],
      };
      const restrictedModels = {
        models: [
          {
            slug: 'test-model',
            apply_patch_tool_type: null,
            use_responses_lite: false,
            web_search_tool_type: 'text_and_image',
          },
        ],
      };
      writeFileSync(
        path.join(evidence, 'models-original.json'),
        JSON.stringify(originalModels),
      );
      writeFileSync(
        path.join(evidence, 'models-readonly.json'),
        JSON.stringify(restrictedModels),
      );
      writeFileSync(
        path.join(evidence, 'models.json'),
        JSON.stringify(restrictedModels),
      );
      writeFileSync(
        path.join(evidence, 'config.toml'),
        'web_search = "live"\nsandbox_mode = "read-only"\n[mcp_servers.benchmark_readonly]\n[mcp_servers.benchmark_readonly.env]\n',
      );
      writeFileSync(
        path.join(evidence, 'prompt-input.json'),
        JSON.stringify([
          {
            role: 'developer',
            content: [
              {
                text: 'file: /home/agent/benchmark/home/.codex/skills/anycloud/SKILL.md',
              },
            ],
          },
        ]),
      );
      writeFileSync(
        path.join(evidence, 'sessions/rollout.jsonl'),
        JSON.stringify({
          type: 'turn_context',
          payload: { model: 'test-model' },
        }),
      );
      writeFileSync(
        path.join(evidence, 'runtime.json'),
        JSON.stringify({
          home: '/home/agent/benchmark/home',
          inferenceProvider: 'sandboxd',
          skillInstalledSha256: hash,
        }),
      );
      const events = [{ type: 'thread.started' }, { type: 'turn.completed' }];
      expect(
        codexCapabilityError(evidence, events, 'skill', 'test-model', hash),
      ).toBeNull();
      expect(
        codexCapabilityError(
          evidence,
          [
            ...events,
            {
              item: {
                type: 'mcp_tool_call',
                server: 'codex',
                tool: 'list_mcp_resources',
              },
            },
          ],
          'skill',
          'test-model',
          hash,
        ),
      ).toBeNull();
      expect(
        codexCapabilityError(evidence, events, 'task', 'test-model', hash),
      ).toBeTruthy();
      expect(
        codexCapabilityError(evidence, events, 'skill', 'other-model', hash),
      ).toBeTruthy();
      expect(
        codexCapabilityError(evidence, [], 'skill', 'test-model', hash),
      ).toBeTruthy();
      expect(
        codexCapabilityError(
          evidence,
          [...events, { item: { type: 'command_execution' } }],
          'skill',
          'test-model',
          hash,
        ),
      ).toBeTruthy();
      expect(
        codexCapabilityError(
          evidence,
          [
            ...events,
            { item: { type: 'mcp_tool_call', server: 'host', tool: 'run' } },
          ],
          'skill',
          'test-model',
          hash,
        ),
      ).toBeTruthy();
      expect(
        codexCapabilityError(
          evidence,
          events,
          'skill',
          'test-model',
          '0'.repeat(64),
        ),
      ).toBeTruthy();
      writeFileSync(
        path.join(evidence, 'features.txt'),
        'shell_tool stable true',
      );
      expect(
        codexCapabilityError(evidence, events, 'skill', 'test-model', hash),
      ).toBeTruthy();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('restricts Claude to read-only tools and isolates external integrations in every condition', () => {
    for (const condition of conditions) {
      const args = claudeArguments(condition, '/isolated/plugin');
      expect(args[args.indexOf('--tools') + 1]).toBe(
        'Read,Skill,WebSearch,WebFetch',
      );
      expect(args).not.toContain('--bare');
      expect(
        JSON.parse(args[args.indexOf('--settings') + 1]).disableAllHooks,
      ).toBe(true);
      expect(args).toContain('--strict-mcp-config');
      expect(args[args.indexOf('--mcp-config') + 1]).toBe('{"mcpServers":{}}');
      expect(args.includes('--plugin-dir')).toBe(condition === 'skill');
      expect(args.includes('--disable-slash-commands')).toBe(
        condition !== 'skill',
      );
    }
  });

  const plugin = '/isolated/plugin';
  const init = {
    type: 'system',
    subtype: 'init',
    apiKeySource: 'none',
    tools: ['Read', 'Skill', 'WebSearch', 'WebFetch'],
    skills: ['anycloud:anycloud', 'debug'],
    plugins: [
      { name: 'anycloud', path: plugin },
      { name: 'bundled', path: 'builtin' },
    ],
    mcp_servers: [],
  };

  it('accepts advertised research capabilities and the intended external skill', () => {
    expect(claudeCapabilityError([init], 'skill', plugin)).toBeNull();
    expect(
      claudeCapabilityError(
        [{ ...init, skills: [], plugins: [] }],
        'task',
        plugin,
      ),
    ).toBeNull();
  });

  it.each([
    { ...init, tools: ['Read'] }, // Bare mode can list skills without exposing their tool.
    { ...init, tools: ['Read', 'WebFetch', 'WebSearch'] },
    { ...init, skills: [] },
    { ...init, apiKeySource: 'ANTHROPIC_API_KEY' },
    { ...init, apiKeySource: 'apiKeyHelper' },
    { ...init, tools: [...init.tools, 'Bash'] },
    { ...init, mcp_servers: [{ name: 'host-integration' }] },
    { ...init, plugins: [{ name: 'anycloud', path: '/host/plugin' }] },
    {
      ...init,
      plugins: [...init.plugins, { name: 'personal', path: '/host' }],
    },
  ])(
    'rejects invalid runtime capabilities even when a completion succeeded',
    (invalid) => {
      expect(
        claudeCapabilityError(
          [invalid, { type: 'result', is_error: false }],
          'skill',
          plugin,
        ),
      ).not.toBeNull();
    },
  );

  const setupInit = {
    ...init,
    tools: ['Bash', 'Read', 'Write', 'Edit', 'WebFetch'],
    skills: [],
    plugins: [],
  };

  it('gives only the setup condition shell and edit tools, still isolated', () => {
    const args = claudeArguments('setup', '');
    expect(args[args.indexOf('--tools') + 1]).toBe(
      'Bash,Read,Write,Edit,WebFetch',
    );
    expect(args).toContain('--disable-slash-commands');
    expect(args).not.toContain('--plugin-dir');
    expect(claudeCapabilityError([setupInit], 'setup', '')).toBeNull();
    for (const invalid of [
      { ...setupInit, tools: ['Read', 'WebFetch'] },
      { ...setupInit, tools: [...setupInit.tools, 'Skill'] },
      { ...setupInit, apiKeySource: 'ANTHROPIC_API_KEY' },
      { ...setupInit, plugins: [{ name: 'personal', path: '/host' }] },
    ])
      expect(claudeCapabilityError([invalid], 'setup', '')).not.toBeNull();
  });

  it('keeps only the Codex shell on for setup and validates its features and turn', () => {
    const args = codexConfigArguments('setup');
    expect(args).not.toContain('features.shell_tool=false');
    expect(args).not.toContain('features.unified_exec=false');
    expect(args).toContain('features.hooks=false');
    const features = codexDisabledFeatures
      .map(
        (feature) =>
          `${feature} stable ${['shell_tool', 'unified_exec'].includes(feature)}`,
      )
      .join('\n');
    const turn = [{ type: 'thread.started' }, { type: 'turn.completed' }];
    expect(codexSetupCapabilityError(features, turn)).toBeNull();
    expect(
      codexSetupCapabilityError(
        features.replace('hooks stable false', 'hooks stable true'),
        turn,
      ),
    ).toContain('hooks');
    expect(
      codexSetupCapabilityError(
        features.replace('shell_tool stable true', 'shell_tool stable false'),
        turn,
      ),
    ).toContain('shell_tool');
    expect(
      codexSetupCapabilityError(features, [
        ...turn,
        { type: 'item.completed', item: { type: 'mcp_tool_call' } },
      ]),
    ).not.toBeNull();
    expect(codexSetupCapabilityError(features, [turn[0]])).not.toBeNull();
  });

  it('rejects missing initialization and skill contamination of controls', () => {
    expect(claudeCapabilityError([], 'task', plugin)).not.toBeNull();
    expect(claudeCapabilityError([init], 'research', plugin)).not.toBeNull();
  });

  it('excludes successful CLI completions with missing capabilities and cleans isolated homes', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'discovery-runtime-test-'));
    try {
      const bin = path.join(root, 'bin');
      mkdirSync(bin);
      writeFileSync(
        path.join(bin, 'claude'),
        `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('mock'); process.exit(0); }
console.log(JSON.stringify({type:'system',subtype:'init',apiKeySource:'none',tools:['Read'],skills:[],plugins:[],mcp_servers:[],apiKey:process.env.ANTHROPIC_API_KEY??null,token:process.env.CLAUDE_CODE_OAUTH_TOKEN??null,home:process.env.HOME,homeReal:require('node:fs').realpathSync(process.env.HOME),cwd:process.cwd()}));
console.log(JSON.stringify({type:'result',is_error:false}));
`,
        { mode: 0o755 },
      );
      const output = path.join(root, 'evidence');
      const result = spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          'benchmarks/agent-discovery/run.ts',
          'run',
          output,
          '--agent',
          'claude',
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${bin}${path.delimiter}${process.env.PATH}`,
            ANTHROPIC_API_KEY: 'personal-key',
            CLAUDE_CODE_OAUTH_TOKEN: 'subscription-token',
          },
        },
      );
      expect(result.status).not.toBe(0);
      const manifest = JSON.parse(
        readFileSync(path.join(output, 'manifest.json'), 'utf8'),
      );
      for (const run of manifest.runs) {
        const execution = JSON.parse(
          readFileSync(path.join(output, run.id, 'execution.json'), 'utf8'),
        );
        expect(execution.exitCode).toBe(0);
        expect(execution.error).toBeTruthy();
        const init = JSON.parse(
          readFileSync(
            path.join(output, run.id, 'transcript.jsonl'),
            'utf8',
          ).split('\n')[0],
        );
        expect(init.apiKey).toBeNull();
        expect(init.token).toBe('subscription-token');
        expect(init.home).not.toBe(process.env.HOME);
        expect(path.dirname(init.homeReal)).toBe(init.cwd);
        expect(existsSync(init.home)).toBe(false);
      }
      const scores = JSON.parse(
        readFileSync(path.join(output, 'scores.json'), 'utf8'),
      );
      expect(
        scores.every(
          (score: { reviewed: boolean; discovered: null }) =>
            !score.reviewed && score.discovered === null,
        ),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('provides only audited Markdown skill reads and denies traversal, symlinks, and execution', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'discovery-read-tool-'));
    try {
      const skills = path.join(root, 'skills');
      mkdirSync(skills);
      writeFileSync(path.join(skills, 'SKILL.md'), 'skill instructions');
      writeFileSync(path.join(root, 'secret.md'), 'secret');
      symlinkSync(path.join(root, 'secret.md'), path.join(skills, 'escape.md'));
      const requests = [
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2024-11-05' },
        },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        ...[
          path.join(skills, 'SKILL.md'),
          path.join(root, 'secret.md'),
          path.join(skills, 'escape.md'),
        ].map((file, i) => ({
          jsonrpc: '2.0',
          id: i + 3,
          method: 'tools/call',
          params: { name: 'read_file', arguments: { path: file } },
        })),
        {
          jsonrpc: '2.0',
          id: 6,
          method: 'tools/call',
          params: { name: 'exec', arguments: {} },
        },
      ];
      const result = spawnSync(
        'python3',
        ['benchmarks/agent-discovery/readonly-tools.py'],
        {
          encoding: 'utf8',
          input:
            requests.map((request) => JSON.stringify(request)).join('\n') +
            '\n',
          env: {
            ...process.env,
            SKILL_ROOT: skills,
            READ_AUDIT: path.join(root, 'reads.jsonl'),
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      const responses = result.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).result);
      expect(
        responses[1].tools.map((tool: { name: string }) => tool.name),
      ).toEqual(['read_file']);
      expect(responses[2].content[0].text).toBe('skill instructions');
      expect(responses.slice(3).every((response) => response.isError)).toBe(
        true,
      );
      const audit = JSON.parse(
        readFileSync(path.join(root, 'reads.jsonl'), 'utf8'),
      );
      expect(audit.sha256).toBe(
        createHash('sha256').update('skill instructions').digest('hex'),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires a known agent, and a Claude run its token, before creating evidence', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'discovery-agent-'));
    try {
      for (const args of [
        ['prepare'],
        ['prepare', '--agent', 'gemini'],
        ['run', '--agent', 'claude'],
      ]) {
        const output = path.join(root, 'evidence');
        const [mode, ...agent] = args;
        const result = spawnSync(
          process.execPath,
          [
            '--experimental-strip-types',
            'benchmarks/agent-discovery/run.ts',
            mode,
            output,
            ...agent,
          ],
          {
            encoding: 'utf8',
            env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: '' },
          },
        );
        expect(result.status).not.toBe(0);
        expect(existsSync(output)).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prepares all conditions without authentication, never scores unexecuted runs, and refuses overwrites', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'discovery-test-'));
    try {
      const output = path.join(root, 'evidence');
      const args = [
        '--experimental-strip-types',
        'benchmarks/agent-discovery/run.ts',
        'prepare',
        output,
        '2',
        '--agent',
        'claude',
      ];
      const result = spawnSync(process.execPath, args, {
        encoding: 'utf8',
        env: { ...process.env },
      });
      expect(result.status, result.stderr).toBe(0);
      const manifest = JSON.parse(
        readFileSync(path.join(output, 'manifest.json'), 'utf8'),
      );
      expect(manifest.runs).toHaveLength(32);
      expect(
        new Set(manifest.runs.map((run: { id: string }) => run.id)).size,
      ).toBe(32);
      expect(manifest.runs[0].condition).toBe('task');
      expect(manifest.runs[16].condition).toBe('research');
      const scores = JSON.parse(
        readFileSync(path.join(output, 'scores.json'), 'utf8'),
      );
      expect(
        scores.every(
          (score: { reviewed: boolean; discovered: null }) =>
            !score.reviewed && score.discovered === null,
        ),
      ).toBe(true);
      const repeated = spawnSync(process.execPath, args, { encoding: 'utf8' });
      expect(repeated.status).not.toBe(0);
      expect(
        JSON.parse(readFileSync(path.join(output, 'manifest.json'), 'utf8'))
          .runs,
      ).toHaveLength(32);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
