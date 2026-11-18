import { Command } from 'commander';
import { nativeApiBearer } from '../services/auth.js';
import { executeWorkloadCommand } from '../../shared/services/api-client/native.js';
import { printError } from '../utils/output.js';
import { resolveWorkloadId } from './shared.js';

async function writeToStream(
  stream: NodeJS.WriteStream,
  chunk: Buffer,
): Promise<void> {
  if (stream.write(chunk)) return;
  await new Promise<void>((resolve) => stream.once('drain', resolve));
}

export function createExecCommand(): Command {
  return new Command('exec')
    .description("⚡ Run a command in a running workload's container")
    .argument('[args...]', '[workload-id] <command>')
    .addHelpText(
      'after',
      `
Examples:
  $ anycloud exec job-abc123 "nvidia-smi"
  $ anycloud exec job-abc123 "python train.py"
  $ anycloud exec "nvidia-smi"                       # picker fires in TTY

Runs a command in the job's Anycloud-controlled execution environment.
Output is printed to stdout. The process exits with the remote exit code.
Run "anycloud status" for durable lifecycle, error, and status information.

If only one positional argument is given, it is treated as the command and
the workload ID is taken from ANYCLOUD_WORKLOAD_ID or an interactive
picker (TTY only). Provide two positionals to pass both explicitly.
`,
    )
    .action(async (args: string[]) => {
      try {
        if (args.length === 0) {
          printError('Command required. Usage: anycloud exec [id] <command>');
          process.exit(1);
        }

        let id: string | undefined;
        let command: string;
        if (args.length === 1) {
          command = args[0];
        } else {
          id = args[0];
          command = args.slice(1).join(' ');
        }

        const resolvedId = await resolveWorkloadId(id);
        const accessToken = await nativeApiBearer();
        const code = await executeWorkloadCommand(
          accessToken,
          { id: resolvedId, command },
          {
            stdout: (chunk) => writeToStream(process.stdout, chunk),
            stderr: (chunk) => writeToStream(process.stderr, chunk),
          },
        );
        if (code !== 0) {
          process.exitCode = code;
          return;
        }
      } catch (error) {
        printError(`Failed to execute: ${(error as Error).message}`);
        process.exit(1);
      }
    });
}
