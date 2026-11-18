import { execa, type ExecaError } from 'execa';

export interface GCPOperator {
  account: string;
  projectId: string;
  environment: NodeJS.ProcessEnv;
}

/** Select a cached gcloud account, regardless of ambient tokens or impersonation. */
export function gcpOperatorEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const retained = new Set([
    'CLOUDSDK_CONFIG',
    'CLOUDSDK_ACTIVE_CONFIG_NAME',
    'CLOUDSDK_PYTHON',
    'CLOUDSDK_PYTHON_SITEPACKAGES',
  ]);
  return {
    ...Object.fromEntries(
      Object.entries(environment).filter(
        ([name]) =>
          retained.has(name) || !/^(CLOUDSDK_|GOOGLE_|GCP_)/.test(name),
      ),
    ),
    // Empty values also override properties in the selected configuration file.
    CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: '',
    CLOUDSDK_AUTH_ACCESS_TOKEN_FILE: '',
    CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT: '',
    CLOUDSDK_AUTH_LOGIN_CONFIG_FILE: '',
    CLOUDSDK_AUTH_DISABLE_CREDENTIALS: 'false',
    CLOUDSDK_CORE_CHECK_GCE_METADATA: 'false',
    CLOUDSDK_CORE_UNIVERSE_DOMAIN: 'googleapis.com',
    CLOUDSDK_CORE_DISABLE_PROMPTS: '1',
    CLOUDSDK_CORE_DISABLE_FILE_LOGGING: 'true',
    CLOUDSDK_CORE_DISABLE_USAGE_REPORTING: 'true',
    CLOUDSDK_CORE_LOG_HTTP: 'false',
    CLOUDSDK_CORE_HTTP_TIMEOUT: '20',
  };
}

export function gcpOperator(
  account: string,
  projectId: string,
  environment: NodeJS.ProcessEnv = process.env,
): GCPOperator {
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/.test(account)) {
    throw new Error('Select a gcloud operator email with --gcloud-account.');
  }
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) {
    throw new Error('Select a valid GCP project ID with --project-id.');
  }
  return {
    account,
    projectId,
    environment: gcpOperatorEnvironment(environment),
  };
}

/** Authentication and local configuration only; gcloud IAM commands can replay mutations. */
export async function runGcloud(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  try {
    const child = execa('gcloud', [...args, '--quiet', '--verbosity=error'], {
      // Bun-compatible byte capture; see slurp/cli-exec.ts.
      encoding: 'latin1',
      stripFinalNewline: false,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      env: gcpOperatorEnvironment(environment),
      extendEnv: false,
      cleanup: false,
      forceKillAfterDelay: false,
      verbose: 'none',
    });
    let captureClosed = false;
    const stopCapture = () => {
      if (captureClosed) return;
      captureClosed = true;
      if (!child.nodeChildProcess.killed) child.kill();
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    for (const stream of [child.stdout, child.stderr]) {
      stream?.once('close', () => {
        if (!stream.readableEnded) stopCapture();
      });
    }
    // Close inherited pipes at the deadline too; see azure-cli-runner.ts.
    const captureDeadline = setTimeout(stopCapture, 30_000);
    const { stdout } = await child.finally(() => clearTimeout(captureDeadline));
    return Buffer.from(stdout, 'latin1').toString('utf8');
  } catch (error) {
    // Neither Execa's formatted diagnostics nor its cause may expose operator tokens.
    throw new Error(
      (error as ExecaError).code === 'ENOENT'
        ? 'Google Cloud CLI is not installed. Install gcloud and run gcloud auth login.'
        : 'Could not use the selected gcloud login. Run gcloud auth login for that account and try again.',
    );
  }
}

export async function getGCPOperatorDefaults(): Promise<{
  account?: string;
  projectId?: string;
}> {
  const output = await runGcloud([
    'config',
    'list',
    '--format=json(core.account,core.project)',
  ]);
  try {
    const config = JSON.parse(output) as {
      core?: { account?: unknown; project?: unknown };
    };
    return {
      account:
        typeof config.core?.account === 'string'
          ? config.core.account
          : undefined,
      projectId:
        typeof config.core?.project === 'string'
          ? config.core.project
          : undefined,
    };
  } catch {
    throw new Error('gcloud returned invalid configuration output.');
  }
}
