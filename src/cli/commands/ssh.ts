import { Command } from 'commander';
import { apiClient } from '../services/auth.js';
import { shellEscape } from '../../shared/utils.js';
import { type SshAccessMode } from '../../shared/api-contract/workload-management-schemas.js';
import { runLocalSsh } from '../services/ssh.js';
import { printError, printInfo } from '../utils/output.js';
import { resolveWorkloadId } from './shared.js';

export function buildSshRemoteCommand(
  workloadId: string,
  mode: SshAccessMode,
): string | undefined {
  if (mode === 'vm') return undefined;

  const quotedId = shellEscape(workloadId);

  if (mode === 'snapshot') {
    const snapshotName = `${workloadId}-snapshot`;
    const quotedSnapshot = shellEscape(snapshotName);
    const getMounts = `MOUNTS=$(docker inspect --format '{{range .Mounts}}-v {{.Source}}:{{.Destination}} {{end}}' ${quotedId} 2>/dev/null)`;
    const runSnapshot =
      `docker run -it --rm $MOUNTS ${quotedSnapshot} bash 2>/dev/null || ` +
      `docker run -it --rm $MOUNTS ${quotedSnapshot} /bin/sh`;
    return `${getMounts} && docker commit ${quotedId} ${quotedSnapshot} >/dev/null && (${runSnapshot})`;
  }

  return `docker exec -it ${quotedId} bash 2>/dev/null || docker exec -it ${quotedId} /bin/sh`;
}

export function createSshCommand(): Command {
  return new Command('ssh')
    .description('🔌 Open an interactive shell in a workload')
    .argument('[id]', 'Workload ID (omit for interactive picker)')
    .option('--host', 'Open a shell on the underlying host VM')
    .option('--vm', 'Compatibility alias for --host')
    .option(
      '--snapshot',
      'Shell into a snapshot of a workload container that exited while its workload is still live',
    )
    .addHelpText(
      'after',
      `
Examples:
  $ anycloud ssh job-abc123
  $ anycloud ssh service-abc123
  $ anycloud ssh vm-abc123 --host
  $ anycloud ssh job-abc123 --snapshot

By default, opens an interactive shell inside the workload container.
Use --host for the underlying VM. --vm is retained as a compatibility alias.
`,
    )
    .action(
      async (
        id: string | undefined,
        options: { host?: boolean; vm?: boolean; snapshot?: boolean },
      ) => {
        try {
          const selectedModes = [
            options.host === true,
            options.vm === true,
            options.snapshot === true,
          ].filter(Boolean).length;
          if (selectedModes > 1) {
            printError('Choose only one of --host, --vm, or --snapshot.');
            process.exit(1);
          }

          const mode: SshAccessMode =
            options.host || options.vm
              ? 'vm'
              : options.snapshot
                ? 'snapshot'
                : 'container';
          const resolvedId = await resolveWorkloadId(id);
          const api = await apiClient();
          const access = await api.workloads.sshAccess({
            params: { id: resolvedId },
            query: { mode },
          });

          printInfo(
            mode === 'vm'
              ? `Connecting to host ${access.vmIp}...`
              : `Connecting to workload on ${access.vmIp}...`,
          );
          console.log('');

          const code = await runLocalSsh(
            access,
            buildSshRemoteCommand(access.workloadId, mode),
          );
          if (code !== 0) process.exitCode = code;
        } catch (error) {
          printError(`Failed to connect: ${(error as Error).message}`);
          process.exit(1);
        }
      },
    );
}
