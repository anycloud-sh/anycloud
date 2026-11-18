import { CloudType } from './cloud.js';

export const ADMIN_REQUEST_URL =
  'https://anycloud.sh/reference/cli/credentials#ask-an-administrator';
/** The published least-privilege policy (RFC 0047), added inline to the user. */
export const AWS_GENERATION_POLICY_NAME = 'AnycloudAccess';
export const AWS_POLICY_URL =
  'https://anycloud.sh/reference/cli/credentials#aws-permissions';

/** An action the provider authenticated the credential for but refused. */
export interface PermissionDenial {
  /** The denied action, such as `ec2:RunInstances`; null when unnamed. */
  action: string | null;
  /** Whether another region may allow it (an AWS region condition). */
  regional: boolean;
}

/**
 * Why a Workload or submission was refused, for the user to forward to their
 * administrator. It never repeats the provider message, which names the
 * principal and the account, subscription or project.
 */
export function permissionDeniedMessage(options: {
  cloud: CloudType;
  action: string | null;
  region?: string | null;
  /** Where the action was denied, instead of `in <region>`. */
  where?: string;
  /** Which credential, such as `credential "prod"`; this one by default. */
  credential?: string;
}): string {
  const { cloud, action, region, credential = 'this credential' } = options;
  const where = options.where ?? (region ? `in ${region}` : undefined);
  // cloudtype-boundary-ok: only AWS publishes its minimal permissions so far.
  const ask =
    cloud === CloudType.AWS
      ? `Ask your AWS administrator to allow it, or to apply the ${AWS_GENERATION_POLICY_NAME} policy: ${AWS_POLICY_URL}`
      : `Ask your ${cloud} administrator to allow it: ${ADMIN_REQUEST_URL}`;
  return [
    `Permission denied: ${cloud} does not allow ${credential} to perform ${action ?? 'an action Anycloud needs'}${where ? ` ${where}` : ''}.`,
    ask,
  ].join('\n');
}

/**
 * A denial raised by a call whose credential is not the compute credential's,
 * such as an AWS storage mint for a Job on another cloud, so the compute
 * gateway's classifier cannot read it.
 */
export class PermissionDeniedError extends Error {
  /** Which credential was denied, when not the compute one. */
  credential?: string;

  constructor(
    readonly cloud: CloudType,
    readonly action: string | null,
    readonly cause: unknown,
  ) {
    super(`${cloud} denied ${action ?? 'an action'}`);
    this.name = 'PermissionDeniedError';
  }
}
