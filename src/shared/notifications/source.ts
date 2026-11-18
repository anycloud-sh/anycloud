export const API_NOTIFICATION_LABEL_ENV = 'ANYCLOUD_API_LABEL';

const MAX_API_NOTIFICATION_LABEL_LENGTH = 160;

function normalizeApiNotificationLabel(
  value: string | undefined,
): string | undefined {
  const normalized = value?.trim().replace(/\s+/g, ' ');
  if (!normalized) return undefined;
  return normalized.slice(0, MAX_API_NOTIFICATION_LABEL_LENGTH);
}

export function configuredApiNotificationLabel(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return normalizeApiNotificationLabel(env[API_NOTIFICATION_LABEL_ENV]);
}

export function localApiNotificationLabel(options: {
  username: string | undefined;
  hostname: string | undefined;
  port: number;
  defaultPort: number;
  override?: string;
}): string {
  const override = normalizeApiNotificationLabel(options.override);
  if (override) return override;

  const username = normalizeApiNotificationLabel(options.username);
  const hostname = normalizeApiNotificationLabel(options.hostname);
  const base =
    username && hostname
      ? `${username}@${hostname}`
      : (username ?? hostname ?? 'local-api');

  return (
    normalizeApiNotificationLabel(
      options.port === options.defaultPort ? base : `${base}:${options.port}`,
    ) ?? 'local-api'
  );
}

export function hostedApiNotificationLabel(
  workloadId: string,
  ownerUsername: string,
): string {
  const id = normalizeApiNotificationLabel(workloadId) ?? 'hosted-api';
  const owner = normalizeApiNotificationLabel(ownerUsername)?.replace(
    /^@+/,
    '',
  );
  return (
    normalizeApiNotificationLabel(
      owner ? `${id}.anycloud.sh · @${owner}` : `${id}.anycloud.sh`,
    ) ?? 'hosted-api'
  );
}
