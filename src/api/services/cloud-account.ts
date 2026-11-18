import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { CloudType, type CloudCredentials } from '../../shared/cloud.js';
import { createAwsStsClient } from './provider-clients/aws.js';
import { gcpProjectId } from './provider-clients/gcp.js';

/**
 * The account a credential reaches (RFC 0049 C26 (a)): the AWS account, the
 * GCP project or the Azure subscription. A role names its account; an AWS key
 * doesn't, so STS reports it. Lambda keys name none.
 */
export async function cloudAccount(
  credentials: CloudCredentials,
  awsKeyAccount: (key: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  }) => Promise<string> = stsCallerAccount,
): Promise<string | null> {
  // cloudtype-boundary-ok: each credential shape names its account differently.
  switch (credentials.cloudProvider) {
    case CloudType.AWS:
      if ('kind' in credentials) {
        const account = /^arn:aws[\w-]*:iam::(\d{12}):role\//.exec(
          credentials.roleArn,
        )?.[1];
        if (!account) {
          throw new Error(`No AWS account in role ${credentials.roleArn}`);
        }
        return account;
      }
      return awsKeyAccount(credentials);
    case CloudType.GCP:
      return gcpProjectId(credentials);
    case CloudType.Azure:
      return credentials.subscriptionId;
    // cloudtype-boundary-ok: a Lambda key names no account; Cloudflare holds storage only.
    case CloudType.Lambda:
      return null;
    case CloudType.Cloudflare:
      throw new Error('Cloudflare credentials hold storage only');
  }
}

async function stsCallerAccount(key: {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}): Promise<string> {
  const identity = await createAwsStsClient(key, {
    region: 'us-east-1',
  }).send(new GetCallerIdentityCommand({}));
  if (!identity.Account) throw new Error('STS reported no AWS account');
  return identity.Account;
}
