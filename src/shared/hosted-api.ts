import packageJson from '../../package.json' with { type: 'json' };
import { WorkloadType, type WorkloadTypeValue } from './workload.js';

/** What `anycloud login` asks GitHub for, and all a hosted API exchanges. */
export const GITHUB_LOGIN_SCOPES = ['read:org', 'read:packages'] as const;

const HOSTED_API_OWNER_ARG = '--hosted-api-owner';
const HOSTED_API_OWNER_ID_ARG = '--hosted-api-owner-id';

export interface HostedApiOwner {
  ownerUserId: string;
  username: string;
}

export function isHostedApiImage(image: string | null): boolean {
  return (
    image !== null &&
    (image === packageJson.apiImage ||
      image.startsWith(`${packageJson.apiImage}:`) ||
      image.startsWith(`${packageJson.apiImage}@`))
  );
}

export function isHostedApiWorkload(workload: {
  workloadType: WorkloadTypeValue;
  image: string | null;
}): boolean {
  return (
    workload.workloadType === WorkloadType.Service &&
    isHostedApiImage(workload.image)
  );
}

function argumentValue(argv: string[], argument: string): string | undefined {
  const index = argv.indexOf(argument);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${argument} requires a value`);
  }
  return value;
}

export function normalizeUserId(userId: string): string {
  const normalized = userId.trim();
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new Error('User id must be a positive integer');
  }
  return BigInt(normalized).toString();
}

export function hostedApiOwnerFromArgv(
  argv: string[],
): HostedApiOwner | undefined {
  const hasUsername = argv.includes(HOSTED_API_OWNER_ARG);
  const hasUserId = argv.includes(HOSTED_API_OWNER_ID_ARG);
  if (!hasUsername && !hasUserId) return undefined;
  if (!hasUsername || !hasUserId) {
    throw new Error(
      `${HOSTED_API_OWNER_ARG} and ${HOSTED_API_OWNER_ID_ARG} must be provided together`,
    );
  }

  const username = argumentValue(argv, HOSTED_API_OWNER_ARG)!.trim();
  if (!username) {
    throw new Error(`${HOSTED_API_OWNER_ARG} requires a GitHub username`);
  }
  return {
    ownerUserId: normalizeUserId(argumentValue(argv, HOSTED_API_OWNER_ID_ARG)!),
    username,
  };
}
