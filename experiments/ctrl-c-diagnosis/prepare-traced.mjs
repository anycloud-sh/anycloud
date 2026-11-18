import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const evidence = join(root, '.context/ctrl-c-diagnosis');
const manifest = JSON.parse(
  readFileSync(join(evidence, 'manifest.json'), 'utf8'),
);
const bun = realpathSync(join(root, 'node_modules/.bin/bun'));
const mark = (event) =>
  `globalThis[Symbol.for('anycloud.ctrlC.diagnostic')]?.('${event}');`;
const replace = (source, old, replacement) => {
  if (!source.includes(old))
    throw new Error(`Diagnostic patch no longer matches: ${old}`);
  return source.replace(old, replacement);
};
const traced = { ...manifest, artifacts: [] };
for (const artifact of manifest.artifacts.filter((a) => a.entry)) {
  const directory = join(evidence, 'artifacts', `${artifact.variant}-traced`);
  mkdirSync(directory, { recursive: true });
  const parent = resolve(artifact.entry, '../../..');
  cpSync(join(parent, 'dist'), join(directory, 'dist'), { recursive: true });
  cpSync(join(root, 'package.json'), join(directory, 'package.json'));
  const entry = join(directory, 'dist/cli/index.js');
  cpSync(
    join(root, 'experiments/ctrl-c-diagnosis/trace.mjs'),
    join(directory, 'dist/cli/diagnostic.mjs'),
  );
  let index = readFileSync(entry, 'utf8');
  index = index.replace(
    '#!/usr/bin/env node\n',
    '#!/usr/bin/env node\nimport "./diagnostic.mjs";\n',
  );
  writeFileSync(entry, index);
  const helper = join(directory, 'dist/cli/utils/interrupt.js');
  let source = readFileSync(helper, 'utf8');
  source = replace(
    source,
    'const controller = new AbortController();',
    `${mark('watch.enter')}\n    const controller = new AbortController();`,
  );
  if (artifact.variant === 'base') {
    source = replace(
      source,
      'return await work(controller.signal);',
      `${mark('work.start')}\n        const result = await work(controller.signal);\n        ${mark('work.resolved')}\n        return result;`,
    );
  } else {
    source = replace(
      source,
      'const result = await work(controller.signal);',
      `${mark('work.start')}\n        const result = await work(controller.signal);\n        ${mark('work.resolved')}`,
    );
  }
  source = replace(
    source,
    'catch (error) {',
    `catch (error) {\n        ${mark('work.rejected')}`,
  );
  source = replace(
    source,
    'finally {',
    `finally {\n        ${mark('work.finally')}`,
  );
  source = replace(
    source,
    "process.once('SIGINT', interrupt);",
    `const diagnosticInterrupt = () => { ${mark('sigint.handler')} interrupt(); };\n    process.once('SIGINT', diagnosticInterrupt);`,
  );
  source = replace(
    source,
    "process.off('SIGINT', interrupt);",
    "process.off('SIGINT', diagnosticInterrupt);",
  );
  writeFileSync(helper, source);
  const logs = join(directory, 'dist/cli/commands/logs.js');
  let logsSource = readFileSync(logs, 'utf8');
  logsSource = replace(
    logsSource,
    "await new Promise((resolve) => stream.once('drain', resolve));",
    `${mark('stdout.drain.wait')}\n    await new Promise((resolve) => stream.once('drain', resolve));\n    ${mark('stdout.drain.done')}`,
  );
  writeFileSync(logs, logsSource);
  const status = join(directory, 'dist/cli/commands/status.js');
  let statusSource = readFileSync(status, 'utf8');
  statusSource = replace(
    statusSource,
    'response = await fetchStatus(accessToken, statusRequest, options);',
    `${mark('status.request.wait')}\n            response = await fetchStatus(accessToken, statusRequest, options);\n            ${mark('status.request.done')}`,
  );
  statusSource = replace(
    statusSource,
    'await sleep(options.intervalSeconds * 1000, options.signal);',
    `${mark('status.sleep.wait')}\n            await sleep(options.intervalSeconds * 1000, options.signal);\n            ${mark('status.sleep.done')}`,
  );
  writeFileSync(status, statusSource);
  const native = join(directory, 'dist/shared/services/api-client/native.js');
  let nativeSource = readFileSync(native, 'utf8');
  nativeSource = replace(
    nativeSource,
    'for await (const chunk of stream) {',
    `${mark('logs.read.wait')}\n        for await (const chunk of stream) {\n            ${mark('logs.read.done')}`,
  );
  nativeSource = replace(
    nativeSource,
    "                newlineIndex = buffer.indexOf('\\n');\n            }\n        }",
    `                newlineIndex = buffer.indexOf('\\n');\n            }\n            ${mark('logs.read.wait')}\n        }`,
  );
  writeFileSync(native, nativeSource);
  const binary = join(directory, 'anycloud-darwin-arm64');
  execFileSync(
    bun,
    [
      'build',
      '--compile',
      '--target=bun-darwin-arm64',
      entry,
      '--outfile',
      binary,
    ],
    { cwd: root, timeout: 60000, stdio: 'pipe' },
  );
  traced.artifacts.push({
    ...artifact,
    entry,
    binary,
    binarySha256: createHash('sha256')
      .update(readFileSync(binary))
      .digest('hex'),
    interruptSha256: createHash('sha256')
      .update(readFileSync(helper))
      .digest('hex'),
    diagnostic: true,
  });
}
writeFileSync(
  join(evidence, 'manifest-traced.json'),
  JSON.stringify(traced, null, 2) + '\n',
);
console.log('Prepared disposable traced Node and Bun CLI artifacts.');
