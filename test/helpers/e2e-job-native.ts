import { CloudType, type CloudCredentials } from '../../src/shared/cloud.js';
import { Redactor } from '../integration/e2e/internal/artifacts.js';
import type {
  CommandOptions,
  CommandResult,
} from '../integration/e2e/internal/types.js';
import { JobCloudSession } from '../integration/e2e/internal/transports/job-cloud-session.js';
import { JobPrivateCommands } from '../integration/e2e/internal/transports/job-command.js';

export const JOB_NATIVE_CREDENTIALS = {
  aws: {
    cloudProvider: CloudType.AWS,
    accessKeyId: 'original-access',
    secretAccessKey: 'private-original-aws',
  },
  gcp: {
    cloudProvider: CloudType.GCP,
    projectId: 'original-project',
    clientEmail: 'original@original-project.iam.gserviceaccount.com',
    privateKey: 'private-original-gcp',
  },
  azure: {
    cloudProvider: CloudType.Azure,
    subscriptionId: '11111111-1111-1111-1111-111111111111',
    directoryId: '22222222-2222-2222-2222-222222222222',
    applicationId: '33333333-3333-3333-3333-333333333333',
    secret: 'private-original-azure',
  },
} as const satisfies Record<string, CloudCredentials>;

export function jobNativeSessionFixture(
  credential: ConstructorParameters<typeof JobCloudSession>[0]['credential'],
  reply: (
    executable: string,
    args: readonly string[],
  ) => string | Partial<CommandResult> = () => {
    throw new Error('unexpected native command');
  },
) {
  const calls: Array<{
    executable: string;
    args: readonly string[];
    options?: CommandOptions;
  }> = [];
  const privateFiles: Array<{ name: string; contents: string }> = [];
  const foreground = new AbortController();
  const cleanup = new AbortController();
  const redactor = new Redactor();
  const runner = {
    run: async (
      executable: string,
      args: readonly string[],
      options?: CommandOptions,
    ): Promise<CommandResult> => {
      calls.push({ executable, args: [...args], options });
      let result: string | Partial<CommandResult>;
      if (executable === 'aws' && args[0] === 'sts')
        result = JSON.stringify({
          Account: '123456789012',
          Arn: 'arn:aws:iam::123456789012:user/original',
          UserId: 'AIDAORIGINAL',
        });
      else if (
        executable === 'gcloud' &&
        args[0] === 'auth' &&
        args[1] === 'activate-service-account'
      )
        result = '';
      else if (executable === 'gcloud' && args[0] === 'projects')
        result = JSON.stringify({
          projectId: JOB_NATIVE_CREDENTIALS.gcp.projectId,
          projectNumber: '1234567890',
        });
      else if (executable === 'az' && args[0] === 'login') result = '';
      else if (
        executable === 'az' &&
        args[0] === 'account' &&
        args[1] === 'show'
      )
        result = JSON.stringify({
          id: JOB_NATIVE_CREDENTIALS.azure.subscriptionId,
          tenantId: JOB_NATIVE_CREDENTIALS.azure.directoryId,
        });
      else result = reply(executable, args);
      return {
        executable,
        args: [...args],
        exitCode: 0,
        signal: null,
        stdout: typeof result === 'string' ? result : '',
        stderr: '',
        combined: typeof result === 'string' ? result : '',
        durationMs: 1,
        timedOut: false,
        aborted: false,
        outputTruncated: false,
        ...(typeof result === 'string' ? {} : result),
      };
    },
  };
  const commands = new JobPrivateCommands(runner, foreground.signal);
  const cleanupCommands = new JobPrivateCommands(runner, cleanup.signal);
  const session = new JobCloudSession({
    name: 'original-native',
    credential,
    commands,
    cleanupCommands,
    redactor,
    files: {
      directory: async (name) => `/private-test/${name}`,
      privateText: async (name, contents) => {
        privateFiles.push({ name, contents });
        return `/private-test/${name}`;
      },
    },
  });
  return {
    session,
    commands,
    cleanupCommands,
    foreground,
    cleanup,
    calls,
    privateFiles,
    redactor,
  };
}
