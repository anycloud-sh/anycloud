import { CloudType } from '../../shared/cloud.js';
import { exitWithError } from './output.js';
import { safePrompts } from './safe-prompts.js';

export const PROVIDER_PROMPT_CHOICES = [
  { title: 'AWS (Amazon Web Services)', value: 'aws' },
  { title: 'GCP (Google Cloud)', value: 'gcp' },
  { title: 'Azure (Microsoft Azure)', value: 'azure' },
  { title: 'Lambda (Lambda Labs)', value: 'lambda' },
];

const COMPUTE_PROVIDERS: Readonly<Record<string, CloudType>> = {
  aws: CloudType.AWS,
  azure: CloudType.Azure,
  gcp: CloudType.GCP,
  lambda: CloudType.Lambda,
};

// Credentials also cover storage-only Cloudflare, which no compute command takes.
const CREDENTIAL_PROVIDERS: Readonly<Record<string, CloudType>> = {
  ...COMPUTE_PROVIDERS,
  cloudflare: CloudType.Cloudflare,
};

function parseProvider(
  raw: string,
  providers: Readonly<Record<string, CloudType>>,
): CloudType {
  const provider = providers[raw.toLowerCase()];
  if (provider) return provider;
  const names = Object.keys(providers);
  exitWithError(
    `Invalid cloud "${raw}". Must be ${names.slice(0, -1).join(', ')}, or ${names.at(-1)}.`,
  );
}

export function normalizeProvider(raw: string): CloudType {
  return parseProvider(raw, COMPUTE_PROVIDERS);
}

export function normalizeCredentialProvider(raw: string): CloudType {
  return parseProvider(raw, CREDENTIAL_PROVIDERS);
}

export async function normalizeProviderOrPrompt(
  raw: string | undefined,
  opts: {
    allowPrompt: boolean;
    missingError: string;
    message?: string;
  },
): Promise<CloudType> {
  if (raw !== undefined) return normalizeProvider(raw);
  if (!opts.allowPrompt) exitWithError(opts.missingError);

  const selection = await safePrompts<'provider'>({
    type: 'select',
    name: 'provider',
    message: opts.message ?? 'Pick a cloud',
    choices: PROVIDER_PROMPT_CHOICES,
  });
  if (!selection.provider) process.exit(0);
  return normalizeProvider(String(selection.provider));
}
