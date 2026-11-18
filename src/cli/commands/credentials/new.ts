import { Command } from 'commander';
import { apiClient } from '../../services/auth.js';
import {
  saveRoleConnection,
  type RoleConnectionOptions,
  refuseRoleOnlyFlags,
} from '../../services/role-connection-setup.js';
import {
  acquireCredentialsFromOptions,
  acquireCredentialsInteractive,
  acquireGeneratedCredentials,
  approveCredentialSave,
  resolveCredentialName,
  validateGenerationSelection,
  type CredentialAcquisition,
  type CredentialOnboardingOptions,
} from '../../services/credential-onboarding/index.js';
import {
  createSpinner,
  exitIfActionRequired,
  printError,
  printInfo,
  printSuccess,
} from '../../utils/output.js';
import { shouldAllowPrompts } from '../../utils/safe-prompts.js';
import { withLifecycleUsageExit } from '../../utils/lifecycle-result.js';
import {
  credentialNameTaken,
  saveCredential,
} from '../../use-cases/save-credential.js';

export function createNewCommand(): Command {
  return withLifecycleUsageExit(new Command('new'))
    .description('➕ Create new credentials')
    .argument('[name]', 'Name for the credential set (prompted if omitted)')
    .option('--provider <provider>', 'Cloud (aws|azure|gcp|lambda|cloudflare)')
    .option(
      '--profile <name>',
      'AWS profile to import, or operator profile with --generate',
    )
    .option('--account-id <id>', 'AWS --generate account or Cloudflare account')
    .option('--access-key-id <id>', 'AWS access key ID')
    .option('--secret-access-key <key>', 'AWS secret access key')
    .option('--application-id <id>', 'Azure application (client) ID')
    .option('--secret <secret>', 'Azure client secret')
    .option('--subscription-id <id>', 'Azure subscription ID')
    .option('--directory-id <id>', 'Azure directory (tenant) ID')
    .option('--project-id <id>', 'GCP project ID')
    .option('--gcloud-account <email>', 'GCP operator account for --generate')
    .option('--client-email <email>', 'GCP service-account client email')
    .option('--private-key <key>', 'GCP service-account private key')
    .option('--api-key <key>', 'Lambda Labs API key')
    .option('--api-token <token>', 'Cloudflare API token (R2 read and write)')
    .option('--jurisdiction <name>', 'Cloudflare R2: default, eu, or fedramp')
    .option(
      '--generate',
      'Generate AWS, Azure, or GCP credentials with the authenticated provider CLI',
    )
    .option(
      '--role',
      'Connect an AWS, GCP or Azure role to a self-hosted API instead of saving a key',
    )
    .option('--role-arn <arn>', 'AWS role ARN for --role')
    .option(
      '--workload-identity-provider <name>',
      'GCP workload identity provider for --role',
    )
    .option(
      '--service-account-email <email>',
      'GCP service account email for --role',
    )
    .option('--overwrite', 'Overwrite existing credentials with the same name')
    .option(
      '--apply',
      "With --role: create the role through this machine's signed-in aws, gcloud or az, then save it",
    )
    .option('--json', 'With --role: emit the saved role connection as JSON')
    .addHelpText(
      'after',
      `
Examples:
  Interactive (TTY):
    $ anycloud credentials new                 # prompts for the name, then the provider wizard
    $ anycloud credentials new prod-aws        # picker for provider, static-profile/manual flow
    $ anycloud creds new dev-gcp               # discovers or uploads a service-account key file

  Non-interactive (CI / scripts):
    $ anycloud credentials new prod-aws --provider aws \\
        --access-key-id AKIA... --secret-access-key ...
    $ anycloud credentials new prod-aws --provider aws --profile production
    $ anycloud credentials new ci-aws --provider aws --generate --profile operator --account-id 123456789012

    $ anycloud credentials new prod-azure --provider azure \\
        --application-id ... --secret ... --subscription-id ... --directory-id ...

    $ anycloud credentials new prod-gcp --provider gcp \\
        --project-id my-proj --client-email sa@my-proj.iam.gserviceaccount.com \\
        --private-key "-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----\\n"

    $ anycloud credentials new ci-azure --provider azure --generate --subscription-id ...
    $ anycloud credentials new ci-gcp --provider gcp --generate --gcloud-account operator@example.com --project-id my-project

    $ anycloud credentials new prod-lambda --provider lambda --api-key ...

    $ anycloud credentials new r2 --provider cloudflare --account-id ... --api-token ...

  Role connections (self-hosted API; prints the setup, then saves no secret):
    $ anycloud credentials new prod-aws --provider aws --role
    $ anycloud credentials new prod-aws --provider aws --role --role-arn arn:aws:iam::123456789012:role/...
    $ anycloud credentials new prod-gcp --provider gcp --role \\
        --workload-identity-provider projects/123/locations/global/workloadIdentityPools/anycloud/providers/anycloud-api \\
        --service-account-email anycloud-role@my-proj.iam.gserviceaccount.com
    $ anycloud credentials new prod-azure --provider azure --role \\
        --application-id ... --directory-id ... --subscription-id ...
    $ anycloud credentials new prod-aws --provider aws --role --role-arn ... --json
    $ anycloud credentials new prod-gcp --provider gcp --role --apply --json

Environment-variable fallback (used when a flag is not passed):
  AWS:      AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
  Azure:    AZURE_APPLICATION_ID, AZURE_SECRET, AZURE_SUBSCRIPTION_ID, AZURE_DIRECTORY_ID
  GCP:      GCP_PROJECT_ID, GCP_CLIENT_EMAIL, GCP_PRIVATE_KEY
  Lambda:   LAMBDA_API_KEY
  Cloudflare: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN (only with --provider)
  Provider: ANYCLOUD_CLOUD_PROVIDER (alternative to --provider)

In CI (CI=true) or non-TTY shells, the wizard is skipped. Provide every required
credential flag, import an AWS profile, or explicitly use --generate for AWS,
Azure, or GCP with an authenticated provider CLI and the required target flags.
`,
    )
    .action(
      async (
        name: string | undefined,
        options: CredentialOnboardingOptions &
          RoleConnectionOptions & { role?: boolean },
      ) => {
        if (options.role) return saveRoleConnection(name, options);
        refuseRoleOnlyFlags(options);
        try {
          const resolvedName = await resolveCredentialName(name);
          if (options.generate) {
            validateGenerationSelection(resolvedName, options);
          }

          // Imported credentials can be built before touching the API. Both
          // interactive and explicit generation create remote cloud resources,
          // so defer those paths until after the duplicate-name check.
          const allowPrompts = shouldAllowPrompts();
          let acquired: CredentialAcquisition | undefined;
          if (!options.generate && !allowPrompts) {
            acquired = await acquireCredentialsFromOptions(options);
          }

          const client = await apiClient();
          if (
            !options.overwrite &&
            (await credentialNameTaken(client, resolvedName))
          ) {
            printError(
              `Credentials "${resolvedName}" already exist. Pass --overwrite to replace.`,
            );
            process.exit(1);
          }

          acquired ??= options.generate
            ? await acquireGeneratedCredentials(resolvedName, options)
            : await acquireCredentialsInteractive(resolvedName, options);

          if (!(await approveCredentialSave(resolvedName, acquired))) return;

          const spinner = createSpinner(
            `Saving credentials "${resolvedName}"...`,
          ).start();
          await saveCredential(
            client,
            resolvedName,
            acquired,
            options.overwrite === true,
          ).finally(() => spinner.stop());
          printSuccess(`Credentials "${resolvedName}" saved successfully!`);
          printInfo(`Provider: ${acquired.credential.cloudProvider}`);
        } catch (error) {
          exitIfActionRequired(error);
          printError(`Failed to add credentials: ${(error as Error).message}`);
          process.exit(1);
        }
      },
    );
}
