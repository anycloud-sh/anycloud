import { Command } from 'commander';
import { apiClient } from '../../services/auth.js';
import { newTable } from '../../renderers/table.js';
import chalk from 'chalk';
import { printSuccess, printInfo, setJsonMode } from '../../utils/output.js';
import { CloudType } from '../../../shared/cloud.js';
import { discoverCredentialSources } from '../../services/credential-onboarding/index.js';

export function createListCommand(): Command {
  return new Command('list')
    .description('📋 List saved credentials and discover local cloud profiles')
    .option(
      '--json',
      'Emit saved credentials as JSON (name, provider, kind and health)',
    )
    .addHelpText(
      'after',
      `
Examples:
  $ anycloud credentials list
  $ anycloud creds list
  $ anycloud credentials list --json   # machine-readable output

Shows credentials stored in anycloud, plus local AWS/GCP profiles that
"anycloud credentials new" can pick up.
`,
    )
    .action(async (options?: { json?: boolean }) => {
      if (options?.json) setJsonMode(true);

      const api = await apiClient();
      const saved = await api.credentials.list();

      if (options?.json) {
        const payload = saved.map((c) => ({
          name: c.name,
          cloudProvider: c.cloudProvider,
          kind: 'kind' in c && c.kind === 'role' ? 'role' : 'key',
          health: c.authFailedAt != null ? 'invalid' : 'ok',
          ...(c.authFailedAt != null ? { invalidSince: c.authFailedAt } : {}),
        }));
        console.log(JSON.stringify(payload));
        return;
      }

      if (saved.length === 0) {
        printInfo('No saved credentials.');
      } else {
        printSuccess(`Saved (${saved.length}):`);
        console.log('');
        const table = newTable({
          head: ['Name', 'Provider', 'Health', 'Details'].map((h) =>
            chalk.cyan(h),
          ),
          colWidths: [20, 12, 26, 64],
          style: { head: [], border: ['dim'] },
        });

        for (const cred of saved) {
          let details = '';
          if (cred.cloudProvider === CloudType.AWS && cred.roleArn) {
            // Split so the table doesn't truncate a long ARN.
            const [, account, role] =
              /^arn:aws:iam::(\d+):role\/(.+)$/.exec(cred.roleArn) ?? [];
            details = `Role: ${role ?? cred.roleArn}\nAccount: ${account ?? ''}`;
          } else if (
            cred.cloudProvider === CloudType.GCP &&
            cred.workloadIdentityProvider &&
            cred.serviceAccountEmail
          ) {
            const [, project, pool, provider] =
              /^projects\/(\d+)\/locations\/global\/workloadIdentityPools\/([^/]+)\/providers\/([^/]+)$/.exec(
                cred.workloadIdentityProvider,
              ) ?? [];
            details = `Role: ${cred.serviceAccountEmail}\nProvider: ${pool}/${provider} (project ${project})`;
          } else if (cred.cloudProvider === CloudType.Azure && cred.kind) {
            details = `Role: ${cred.applicationId ?? ''}\nTenant: ${cred.directoryId ?? ''}\nSubscription: ${cred.subscriptionId ?? ''}`;
          } else if (cred.cloudProvider === CloudType.AWS && cred.accessKeyId) {
            details = `Access Key: ${cred.accessKeyId}`;
          } else if (
            cred.cloudProvider === CloudType.GCP &&
            cred.projectId &&
            cred.clientEmail
          ) {
            details = `Project: ${cred.projectId}\nEmail: ${cred.clientEmail}`;
          } else if (
            cred.cloudProvider === CloudType.Azure &&
            cred.subscriptionId &&
            cred.applicationId
          ) {
            details = `Subscription: ${cred.subscriptionId}\nApp ID: ${cred.applicationId}`;
          } else if (
            cred.cloudProvider === CloudType.Cloudflare &&
            cred.accountId
          ) {
            details = `Account: ${cred.accountId}${cred.jurisdiction ? `\nJurisdiction: ${cred.jurisdiction}` : ''}`;
          }
          const health =
            cred.authFailedAt != null
              ? chalk.red(
                  `invalid (since ${new Date(cred.authFailedAt).toISOString().slice(0, 10)})`,
                )
              : chalk.dim('ok');
          table.push([cred.name, cred.cloudProvider, health, details]);
        }
        console.log(table.toString());
      }

      const discovered = await discoverCredentialSources();

      if (discovered.length === 0) {
        if (saved.length === 0) {
          printInfo('Use "anycloud credentials new" to add credentials.');
        }
        return;
      }

      console.log('');
      printInfo(
        `Discovered (${discovered.length}) — not yet saved to anycloud:`,
      );
      console.log('');
      const discTable = newTable({
        head: ['Source', 'Provider', 'Details'].map((h) => chalk.cyan(h)),
        colWidths: [32, 12, 80],
        style: { head: [], border: ['dim'] },
      });
      for (const d of discovered) {
        discTable.push([d.source, d.provider, d.identity]);
      }
      console.log(discTable.toString());
      console.log('');
      printInfo(
        'Save one with "anycloud credentials new <name>" — the wizard picks these up.',
      );
    });
}
