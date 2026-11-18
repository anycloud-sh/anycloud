import { readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import ini from 'ini';
import { isCliInstalled } from './cli-exec.js';
import type { ErrorWithCode } from '../../../shared/error-formatter.js';

/**
 * AWS CLI credentials profile entry
 */
export interface AWSProfile {
  aws_access_key_id?: string;
  aws_secret_access_key?: string;
  aws_session_token?: string;
}

/**
 * AWS CLI config profile entry
 */
interface AWSConfigProfile {
  region?: string;
  aws_access_key_id?: string;
  aws_secret_access_key?: string;
  aws_session_token?: string;
}

/**
 * AWS credentials parsed from ~/.aws/credentials
 * Structure: { [profileName]: { aws_access_key_id, aws_secret_access_key } }
 */
type AWSCredentialsFile = Record<string, AWSProfile>;

/**
 * AWS config parsed from ~/.aws/config
 * Structure: { [profileName]: { region, ... } }
 * Note: In config file, profiles are prefixed with "profile " except for "default"
 */
type AWSConfigFile = Record<string, AWSConfigProfile>;

const REDACTED_AWS_SECRET = '<redacted>';

/**
 * Complete AWS credentials with region
 */
interface AWSCredsCLI {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region?: string;
  profileName: string;
}

export type AWSProfileSource =
  | { kind: 'static'; credentials: AWSCredsCLI }
  | { kind: 'temporary'; credentials: AWSCredsCLI }
  | { kind: 'non-static'; profileName: string }
  | { kind: 'incomplete'; profileName: string; missing: string[] }
  | { kind: 'missing'; profileName: string };

/**
 * Get AWS config directory path
 */
export function getAWSDir(): string {
  return join(homedir(), '.aws');
}

/**
 * Get AWS credentials file path
 */
export function getAWSCredentialsPath(): string {
  return (
    process.env.AWS_SHARED_CREDENTIALS_FILE || join(getAWSDir(), 'credentials')
  );
}

/**
 * Get AWS config file path
 */
export function getAWSConfigPath(): string {
  return process.env.AWS_CONFIG_FILE || join(getAWSDir(), 'config');
}

/**
 * Read AWS credentials file (~/.aws/credentials)
 * Returns map of profile names to credentials
 */
export async function readAWSCredentials(): Promise<
  Record<string, AWSProfile>
> {
  const credentialsPath = getAWSCredentialsPath();

  try {
    const content = await readFile(credentialsPath, 'utf-8');
    const parsed: AWSCredentialsFile = ini.parse(content);
    return parsed;
  } catch (error) {
    const readError = new Error(
      `Failed to read AWS credentials from ${credentialsPath}: ${(error as Error).message}`,
    ) as ErrorWithCode;
    readError.code = (error as NodeJS.ErrnoException).code;
    throw readError;
  }
}

/**
 * Read AWS config file (~/.aws/config)
 * Returns map of profile names to config (region, etc.)
 * Note: Removes "profile " prefix from profile names for consistency
 */
export async function readAWSConfig(): Promise<
  Record<string, AWSConfigProfile>
> {
  const configPath = getAWSConfigPath();

  try {
    const content = await readFile(configPath, 'utf-8');
    const parsed: AWSConfigFile = ini.parse(content);

    return normalizeAWSConfigProfiles(parsed);
  } catch {
    // Config file is optional, return empty object if it doesn't exist
    return {};
  }
}

function normalizeAWSConfigProfiles(
  parsed: AWSConfigFile,
): Record<string, AWSConfigProfile> {
  // Remove "profile " prefix from profile names (except "default").
  // Ignore "sso-session" sections; they are session metadata, not profiles.
  const normalized: Record<string, AWSConfigProfile> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key.startsWith('sso-session ')) continue;
    const profileName = key.startsWith('profile ') ? key.substring(8) : key;
    normalized[profileName] = value;
  }
  return normalized;
}

function redactAWSIniSecrets(content: string): string {
  return content.replace(
    /^(\s*(?:aws_secret_access_key|aws_session_token)\s*=\s*)(\S.*)$/gim,
    `$1${REDACTED_AWS_SECRET}`,
  );
}

async function loadRedactedAWSProfileFiles(): Promise<{
  credentials: Record<string, AWSProfile>;
  config: Record<string, AWSConfigProfile>;
}> {
  const credentialsPath = getAWSCredentialsPath();
  const configPath = getAWSConfigPath();
  const [credentials, config] = await Promise.all([
    readFile(credentialsPath, 'utf-8')
      .then(
        (content) =>
          ini.parse(redactAWSIniSecrets(content)) as AWSCredentialsFile,
      )
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return {};
        const readError = new Error(
          `Failed to read AWS credentials from ${credentialsPath}: ${error.message}`,
        ) as ErrorWithCode;
        readError.code = error.code;
        throw readError;
      }),
    readFile(configPath, 'utf-8')
      .then((content) =>
        normalizeAWSConfigProfiles(
          ini.parse(redactAWSIniSecrets(content)) as AWSConfigFile,
        ),
      )
      .catch(() => ({})),
  ]);
  return { credentials, config };
}

async function loadAWSProfileFiles(): Promise<{
  credentials: Record<string, AWSProfile>;
  config: Record<string, AWSConfigProfile>;
}> {
  const [credentials, config] = await Promise.all([
    readAWSCredentials().catch((error: ErrorWithCode) => {
      if (error.code === 'ENOENT') return {};
      throw error;
    }),
    readAWSConfig(),
  ]);
  return { credentials, config };
}

function resolveAWSProfileSourceFromFiles(
  profileName: string,
  credentials: Record<string, AWSProfile>,
  config: Record<string, AWSConfigProfile>,
): AWSProfileSource {
  const credentialProfile = credentials[profileName];
  const configProfile = config[profileName];
  if (!credentialProfile && !configProfile) {
    return { kind: 'missing', profileName };
  }

  // The shared credentials file wins over the config file for credential
  // material, matching the AWS CLI's precedence.
  const credentialFileHasMaterial = Boolean(
    credentialProfile &&
      (credentialProfile.aws_access_key_id !== undefined ||
        credentialProfile.aws_secret_access_key !== undefined ||
        credentialProfile.aws_session_token !== undefined),
  );
  const materialProfile = credentialFileHasMaterial
    ? credentialProfile
    : configProfile;
  const accessKeyId = materialProfile?.aws_access_key_id;
  const secretAccessKey = materialProfile?.aws_secret_access_key;
  const sessionToken = materialProfile?.aws_session_token;

  if (
    accessKeyId !== undefined ||
    secretAccessKey !== undefined ||
    sessionToken !== undefined
  ) {
    if (!accessKeyId || !secretAccessKey) {
      return {
        kind: 'incomplete',
        profileName,
        missing: [
          !accessKeyId ? 'aws_access_key_id' : undefined,
          !secretAccessKey ? 'aws_secret_access_key' : undefined,
        ].filter((value): value is string => value !== undefined),
      };
    }
    const resolved: AWSCredsCLI = {
      accessKeyId,
      secretAccessKey,
      ...(sessionToken ? { sessionToken } : {}),
      region: configProfile?.region,
      profileName,
    };
    return sessionToken
      ? { kind: 'temporary', credentials: resolved }
      : { kind: 'static', credentials: resolved };
  }

  return { kind: 'non-static', profileName };
}

/** Resolve whether a named AWS profile can be imported durably. */
export async function resolveAWSProfileSource(
  profileName: string,
): Promise<AWSProfileSource> {
  const { credentials, config } = await loadAWSProfileFiles();
  return resolveAWSProfileSourceFromFiles(profileName, credentials, config);
}

function awsProfileNames(
  credentials: Record<string, AWSProfile>,
  config: Record<string, AWSConfigProfile>,
): string[] {
  return [...new Set([...Object.keys(credentials), ...Object.keys(config)])];
}

/** List every configured profile, including SSO and other non-importable ones. */
export async function listAWSProfileNames(): Promise<string[]> {
  const { credentials, config } = await loadRedactedAWSProfileFiles();
  return awsProfileNames(credentials, config);
}

/** List profiles containing complete, long-lived static credentials. */
export async function listImportableAWSProfileSummaries(): Promise<
  { profileName: string; accessKeyId: string }[]
> {
  const { credentials, config } = await loadRedactedAWSProfileFiles();
  return awsProfileNames(credentials, config).flatMap((name) => {
    const source = resolveAWSProfileSourceFromFiles(name, credentials, config);
    return source.kind === 'static'
      ? [
          {
            profileName: source.credentials.profileName,
            accessKeyId: source.credentials.accessKeyId,
          },
        ]
      : [];
  });
}

/**
 * Check if AWS CLI is installed
 */
export async function isAWSCLIInstalled(): Promise<boolean> {
  return isCliInstalled('aws');
}

/** Get the selected AWS profile, defaulting to the conventional name. */
export function getCurrentAWSProfile(): string {
  return process.env.AWS_PROFILE || 'default';
}

/** The official per-user installers; both pick the right architecture. */
export function getAWSCLIInstallCommand(): string {
  return process.platform === 'win32'
    ? 'irm https://awscli.amazonaws.com/v2/install.ps1 | iex'
    : 'curl -fsSL https://awscli.amazonaws.com/v2/install.sh | bash';
}
