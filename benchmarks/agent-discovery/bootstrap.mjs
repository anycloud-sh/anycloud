// Runs inside a fresh, mountless Docker microVM before inference.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const root = '/home/agent/benchmark';
const home = path.join(root, 'home');
const codexHome = path.join(home, '.codex');
const work = path.join(root, 'work');
fs.mkdirSync(codexHome, { recursive: true });
fs.mkdirSync(work, { recursive: true });
fs.mkdirSync('/home/agent/benchmark/evidence', { recursive: true });
// Only sandbox-managed inference authentication is retained. No host auth is copied.
fs.copyFileSync(
  '/home/agent/.codex/auth.json',
  path.join(codexHome, 'auth.json'),
);
const original = fs.readFileSync('/home/agent/.codex/config.toml', 'utf8');
const provider = original.match(
  /\[model_providers\.[^\]]+\][\s\S]*?(?=\n\[|$)/,
)?.[0];
const providerName = original.match(/^model_provider\s*=\s*("[^"]+")/m)?.[1];
if (!provider || !providerName)
  throw new Error('Missing sandbox inference proxy');
fs.writeFileSync(
  path.join(codexHome, 'config.toml'),
  `
model_provider = ${providerName}
forced_login_method = "api"
approval_policy = "never"
sandbox_mode = "read-only"
web_search = "live"
${provider}
[mcp_servers.benchmark_readonly]
required = true
command = "python3"
args = ["/opt/readonly-tools.py"]
[mcp_servers.benchmark_readonly.tools.read_file]
approval_mode = "auto"
[mcp_servers.benchmark_readonly.env]
SKILL_ROOT = "${codexHome}/skills"
READ_AUDIT = "/home/agent/benchmark/evidence/reads.jsonl"
`,
);
if (fs.existsSync('/opt/anycloud-SKILL.md')) {
  fs.mkdirSync(path.join(codexHome, 'skills/anycloud'), { recursive: true });
  fs.copyFileSync(
    '/opt/anycloud-SKILL.md',
    path.join(codexHome, 'skills/anycloud/SKILL.md'),
  );
}
const settings = JSON.parse(fs.readFileSync('/opt/settings.json', 'utf8'));
const env = {
  ...process.env,
  HOME: home,
  CODEX_HOME: codexHome,
  XDG_CONFIG_HOME: path.join(home, 'config'),
  XDG_CACHE_HOME: path.join(home, 'cache'),
  XDG_DATA_HOME: path.join(home, 'data'),
};
function capture(name, args) {
  const result = spawnSync('codex', args, {
    cwd: work,
    env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  fs.writeFileSync(
    `/home/agent/benchmark/evidence/${name}`,
    result.stdout || '',
  );
  if (result.status !== 0) throw new Error(`${name} failed: ${result.stderr}`);
}
capture('models-original.json', ['debug', 'models']);
// Keep real model metadata and identity, but remove the advertised editing tool.
const catalog = JSON.parse(
  fs.readFileSync(
    '/home/agent/benchmark/evidence/models-original.json',
    'utf8',
  ),
);
for (const model of catalog.models) model.apply_patch_tool_type = null;
fs.writeFileSync(
  '/home/agent/benchmark/evidence/models-readonly.json',
  JSON.stringify(catalog),
);
// A top-level setting must precede TOML tables.
const config = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
fs.writeFileSync(
  path.join(codexHome, 'config.toml'),
  'model_catalog_json = "/home/agent/benchmark/evidence/models-readonly.json"\n' +
    config,
);
capture('codex-version.txt', ['--version']);
capture('features.txt', ['features', 'list', ...settings.configArgs]);
capture('prompt-input.json', [
  'debug',
  'prompt-input',
  ...settings.configArgs,
  fs.readFileSync('/opt/prompt.txt', 'utf8'),
]);
fs.copyFileSync(
  path.join(codexHome, 'config.toml'),
  '/home/agent/benchmark/evidence/config.toml',
);
fs.writeFileSync(
  '/home/agent/benchmark/evidence/runtime.json',
  JSON.stringify({
    home,
    codexHome,
    work,
    inferenceProvider: JSON.parse(providerName),
    skillInstalledSha256: fs.existsSync(
      path.join(codexHome, 'skills/anycloud/SKILL.md'),
    )
      ? createHash('sha256')
          .update(
            fs.readFileSync(path.join(codexHome, 'skills/anycloud/SKILL.md')),
          )
          .digest('hex')
      : null,
    configArgs: settings.configArgs,
  }),
);
