import { CloudType } from './cloud.js';

/**
 * Where a self-hosted API serves each cloud's role connection setup template,
 * beside its ServiceAccount issuer (RFC 0047 § Role connections).
 */
// cloudtype-boundary-ok: each cloud has its own setup template (RFC 0047).
export const ROLE_SETUP_PATHS = {
  [CloudType.AWS]: '/role-setup/aws.json',
  [CloudType.GCP]: '/role-setup/gcp.sh',
  [CloudType.Azure]: '/role-setup/azure.json',
} as const;

export type RoleSetupCloud = keyof typeof ROLE_SETUP_PATHS;
