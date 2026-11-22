// Runs each argument as a shell command at the same time. Each command says
// when it starts, its output prints as one block when it exits, and the run
// fails if any failed.
import { spawn } from 'node:child_process';

const commands = process.argv.slice(2);
const codes = await Promise.all(
  commands.map(
    (command) =>
      new Promise((resolve) => {
        const started = Date.now();
        const child = spawn(command, {
          shell: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        process.stdout.write(`$ ${command} started\n`);
        let output = '';
        for (const stream of [child.stdout, child.stderr]) {
          stream.setEncoding('utf8');
          stream.on('data', (chunk) => (output += chunk));
        }
        child.on('close', (code) => {
          const seconds = Math.round((Date.now() - started) / 1000);
          process.stdout.write(
            `$ ${command} (exit ${code}, ${seconds} s)\n${output}`,
          );
          resolve(code);
        });
      }),
  ),
);
const failed = commands.filter((_, index) => codes[index] !== 0);
if (failed.length > 0) {
  console.error(`Failed: ${failed.join(', ')}`);
  process.exitCode = 1;
}
