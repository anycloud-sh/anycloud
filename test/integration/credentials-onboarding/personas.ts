/**
 * Provider personas (RFC 0034): recorded response shapes observed from real
 * cloud accounts or published in provider troubleshooting records. Every
 * persona cites its source. Invented provider behavior does not belong here: a
 * test against an imagined response proves nothing.
 */

/** One scripted STS answer for an AWS access key the wizard tries to import. */
export interface AWSStsPersona {
  /** Where this response shape was observed (RFC 0034 invariant 5). */
  provenance: string;
  /** Query action the capture belongs to; any other use must fail loudly. */
  action: 'GetCallerIdentity';
  /** Access key pair the fake STS applies this persona to. */
  accessKeyId: string;
  secretAccessKey: string;
  httpStatus: number;
  errorCode: string;
  errorMessage: string;
}

const WELL_FORMED_AWS_ACCESS_KEY_ID = /^(AKIA|ASIA)[A-Z0-9]{16}$/;
const WELL_FORMED_AWS_SECRET_ACCESS_KEY = /^[A-Za-z0-9/+=]{40}$/;

/**
 * Personas must stay format-faithful: credentials AWS could never issue
 * would quietly shift their journey onto a different rejection branch if
 * local format validation ever appears.
 */
function wellFormedAWSStsPersona(persona: AWSStsPersona): AWSStsPersona {
  if (!WELL_FORMED_AWS_ACCESS_KEY_ID.test(persona.accessKeyId)) {
    throw new Error(
      `Persona access key ID is not a well-formed AWS key: ${persona.accessKeyId}`,
    );
  }
  if (!WELL_FORMED_AWS_SECRET_ACCESS_KEY.test(persona.secretAccessKey)) {
    throw new Error(
      'Persona secret access key is not a well-formed 40-character AWS secret.',
    );
  }
  return persona;
}

/**
 * A well-formed access key pair that AWS rejects outright — deactivated,
 * deleted, or copied from a stale profile.
 */
export const AWS_REJECTED_KEY: AWSStsPersona = wellFormedAWSStsPersona({
  provenance:
    'Captured 2026-09-02 from live STS: a SigV4-signed POST of' +
    ' Action=GetCallerIdentity to sts.us-east-1.amazonaws.com with exactly' +
    ' this fabricated key pair answered HTTP 403 text/xml, ErrorResponse' +
    ' xmlns https://sts.amazonaws.com/doc/2011-06-15/, Type Sender, Code' +
    ' InvalidClientTokenId, Message "The security token included in the' +
    ' request is invalid." (x-amzn-RequestId' +
    ' fac0093c-16e5-4075-a820-18cca5fb651c). Classified by' +
    ' src/cli/services/credential-onboarding/aws-validation.ts.',
  action: 'GetCallerIdentity',
  accessKeyId: 'AKIAREJECTEDTERMINAL',
  secretAccessKey: 'TERMINALREJECTEDSECRETTERMINALREJECTED42',
  httpStatus: 403,
  errorCode: 'InvalidClientTokenId',
  errorMessage: 'The security token included in the request is invalid.',
});

interface AzureDirectoryObjectPersona {
  id: string;
  appId: string;
  displayName: string;
  tags: string[];
}

interface AzureDirectoryListResponsePersona {
  method: 'GET';
  collection: 'applications' | 'servicePrincipals';
  objects: AzureDirectoryObjectPersona[];
}

/** Observed Azure directory-list responses for one account state. */
export interface AzureDirectoryListPersona {
  /** Where these response shapes were observed (RFC 0034 invariant 5). */
  provenance: string;
  credentialName: string;
  responses: AzureDirectoryListResponsePersona[];
}

const WELL_FORMED_AZURE_GUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function wellFormedAzureDirectoryListPersona(
  persona: AzureDirectoryListPersona,
): AzureDirectoryListPersona {
  const displayName = `anycloud-${persona.credentialName}`;
  if (
    persona.responses.some((response) =>
      response.objects.some(
        (object) =>
          !WELL_FORMED_AZURE_GUID.test(object.id) ||
          !WELL_FORMED_AZURE_GUID.test(object.appId) ||
          object.displayName !== displayName,
      ),
    )
  ) {
    throw new Error(
      'Azure directory persona objects must keep GUID-shaped IDs and the captured display name.',
    );
  }
  return persona;
}

/**
 * An application deletion had begun cascading, but its service principal was
 * still visible to directory listing long enough to collide with the name.
 */
export const AZURE_ORPHANED_SERVICE_PRINCIPAL: AzureDirectoryListPersona =
  wellFormedAzureDirectoryListPersona({
    provenance:
      'Captured 2026-09-02 in attempt 1 of CI run 33582076578, Azure job' +
      ' 100098262089: after application cleanup,' +
      ' the post-test sweep still listed the tagged service principal for' +
      ' anycloud-onb-33582076578017 with no matching application. Its direct' +
      ' delete then failed with "ERROR: Insufficient privileges to complete' +
      ' the operation." Object and application IDs below are sanitized to' +
      ' stable GUIDs; the projected fields and tags preserve the incident' +
      ' reconstruction.',
    credentialName: 'onb-33582076578017',
    responses: [
      {
        method: 'GET',
        collection: 'servicePrincipals',
        objects: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            appId: '22222222-2222-4222-8222-222222222222',
            displayName: 'anycloud-onb-33582076578017',
            tags: [
              'AnycloudManaged',
              'AnycloudCredentialName:onb-33582076578017',
            ],
          },
        ],
      },
      { method: 'GET', collection: 'applications', objects: [] },
    ],
  });

/** One documented Entra OAuth token error response. */
export interface AzureOAuthErrorPersona {
  /** Where this response shape was observed (RFC 0034 invariant 5). */
  provenance: string;
  method: 'POST';
  pathSuffix: '/oauth2/v2.0/token';
  httpStatus: number;
  body: { error: string; error_description: string };
}

/** The token response for an expired service-principal client secret. */
export const AZURE_EXPIRED_CLIENT_SECRET: AzureOAuthErrorPersona = {
  provenance:
    "Microsoft's published Azure troubleshooting record includes this HTTP" +
    ' 401 invalid_client response under AADSTS7000222, with the application' +
    ' identifier sanitized here: https://learn.microsoft.com/en-us/troubleshoot/azure/' +
    'azure-kubernetes/error-codes/bad-request-or-invalid-client-secret-error' +
    ' (accessed 2026-09-02).',
  method: 'POST',
  pathSuffix: '/oauth2/v2.0/token',
  httpStatus: 401,
  body: {
    error: 'invalid_client',
    error_description:
      "AADSTS7000222: The provided client secret keys for app '<application-id>' are expired. " +
      'Visit the Azure portal to create new keys for your app: https://aka.ms/NewClientSecret, ' +
      'or consider using certificate credentials for added security: https://aka.ms/certCreds.',
  },
};

/** One scripted Lambda cloud API answer for a rejected API key. */
export interface LambdaApiErrorPersona {
  /** Where this response shape was observed (RFC 0034 invariant 5). */
  provenance: string;
  method: 'GET';
  path: '/ssh-keys';
  apiKey: string;
  httpStatus: number;
  body: {
    error: { code: string; message: string; suggestion: string };
  };
}

/** The Lambda answer for an invalid, expired, or deleted API key. */
export const LAMBDA_INVALID_API_KEY: LambdaApiErrorPersona = {
  provenance:
    'Captured 2026-09-02 from live Lambda: GET' +
    ' https://cloud.lambda.ai/api/v1/ssh-keys with a fabricated key as the' +
    ' Basic-auth username answered HTTP 401 application/json with error' +
    ' code global/invalid-api-key. Sanitized: the per-request request_id' +
    ' field is dropped.',
  method: 'GET',
  path: '/ssh-keys',
  apiKey: 'fabricated-lifecycle-probe-key',
  httpStatus: 401,
  body: {
    error: {
      code: 'global/invalid-api-key',
      message: 'API key was invalid, expired, or deleted.',
      suggestion: 'Check your API key or create a new one, then try again.',
    },
  },
};

/** One scripted GCP compute answer for a fabricated service account. */
export interface GcpComputeErrorPersona {
  /** Where this response shape was observed (RFC 0034 invariant 5). */
  provenance: string;
  method: 'GET';
  pathSuffix: '/instances';
  httpStatus: number;
  body: {
    error: {
      code: number;
      message: string;
      errors: Array<{ message: string; domain: string; reason: string }>;
      status: string;
    };
  };
}

const GCP_UNAUTHENTICATED_MESSAGE =
  'Request had invalid authentication credentials. Expected OAuth 2 access' +
  ' token, login cookie or other valid authentication credential. See' +
  ' https://developers.google.com/identity/sign-in/web/devconsole-project.';

/**
 * The compute answer for a fabricated service account. Captured without
 * endpoint overrides — the production configuration — because a custom
 * endpoint forces scopes and flips the auth library into token exchange,
 * a different failure the universe-domain fake never reaches.
 */
export const GCP_UNAUTHENTICATED: GcpComputeErrorPersona = {
  provenance:
    'Captured 2026-09-02 from live GCP: instances.list through' +
    ' @google-cloud/compute with a fabricated service account (fresh RSA' +
    ' key, no endpoint overrides, so auth used a self-signed JWT) answered' +
    ' HTTP 401 UNAUTHENTICATED from compute.googleapis.com with reason' +
    ' "unauthorized".',
  method: 'GET',
  pathSuffix: '/instances',
  httpStatus: 401,
  body: {
    error: {
      code: 401,
      message: GCP_UNAUTHENTICATED_MESSAGE,
      errors: [
        {
          message: GCP_UNAUTHENTICATED_MESSAGE,
          domain: 'global',
          reason: 'unauthorized',
        },
      ],
      status: 'UNAUTHENTICATED',
    },
  },
};

/**
 * A provider's answer when it authenticated the credential but denied it one
 * action (RFC 0047 invariant 3). Identifiers in the published records are
 * replaced with placeholders; the text is otherwise verbatim.
 */
export interface PermissionDenialPersona {
  provenance: string;
  /** The provider's error code: the SDK error's `name`/`Code` or ARM `code`. */
  code: string;
  httpStatus: number;
  message: string;
  /** The denied action the message names. */
  action: string;
}

/** EC2 refusing a key outside the regions its policy allows. */
export const AWS_EC2_REGION_DENIED: PermissionDenialPersona = {
  provenance:
    'Captured 2026-10-07 in spike run 37554544488 (experiments/aws-restricted-iam,' +
    ' api-iam-lines.log): DescribeVpcs in ap-south-1 with a key allowed ec2:*' +
    ' only in three US regions. The spike redacted the account ID; the user' +
    ' name is replaced. The log ends at the action; the encoded authorization' +
    ' suffix EC2 appends (see sts:DecodeAuthorizationMessage) is restored as a' +
    ' placeholder.',
  code: 'UnauthorizedOperation',
  httpStatus: 403,
  message:
    'You are not authorized to perform this operation. User: arn:aws:iam::<account>:user/pilot is not authorized to perform: ec2:DescribeVpcs because no identity-based policy allows the ec2:DescribeVpcs action. Encoded authorization failure message: <encoded>',
  action: 'ec2:DescribeVpcs',
};

/** S3 denying an action the key's identity policy does not allow. */
export const AWS_S3_ACCESS_DENIED: PermissionDenialPersona = {
  provenance:
    'Published in "Troubleshoot access denied (403 Forbidden) errors in Amazon' +
    ' S3", identity-based policies, implicit denial' +
    ' (https://docs.aws.amazon.com/AmazonS3/latest/userguide/troubleshoot-403-errors.html,' +
    ' accessed 2026-10-09).',
  code: 'AccessDenied',
  httpStatus: 403,
  message:
    'User: arn:aws:iam::<account>:user/MaryMajor is not authorized to perform: s3:GetObject because no identity-based policy allows the s3:GetObject action',
  action: 's3:GetObject',
};

/** A JSON-protocol service (ECR) denying an action. */
export const AWS_ECR_ACCESS_DENIED: PermissionDenialPersona = {
  provenance:
    'Published in "Troubleshooting Amazon ECR error messages"' +
    ' (https://docs.aws.amazon.com/AmazonECR/latest/userguide/common-errors.html,' +
    ' accessed 2026-10-09). The account and user are replaced. The record' +
    ' gives no HTTP status; 400 is what JSON-protocol services send for it.',
  code: 'AccessDeniedException',
  httpStatus: 400,
  message:
    'User: arn:aws:iam::<account>:user/username is not authorized to perform: ecr:GetAuthorizationToken on resource: *',
  action: 'ecr:GetAuthorizationToken',
};

/** STS refusing a key the scoped-token mint (GetFederationToken). */
export const AWS_STS_FEDERATION_DENIED: PermissionDenialPersona = {
  provenance:
    'Quoted in the Transloadit community forum, "S3 upload via Companion:' +
    ' requirement for sts:GetFederationToken policy"' +
    ' (https://community.transloadit.com/t/16911, accessed 2026-10-09).' +
    ' Account, user and federated-user names are replaced.',
  code: 'AccessDenied',
  httpStatus: 403,
  message:
    'User: arn:aws:iam::<account>:user/storage is not authorized to perform: sts:GetFederationToken on resource: arn:aws:sts::<account>:federated-user/<name>',
  action: 'sts:GetFederationToken',
};

/** ARM denying a service principal one management-plane action. */
export const AZURE_AUTHORIZATION_FAILED: PermissionDenialPersona = {
  provenance:
    'Quoted in Microsoft Q&A 422151, "Authorization Failed error for Azure' +
    ' Client" (https://learn.microsoft.com/en-us/answers/questions/422151,' +
    ' accessed 2026-10-09): ARM status 403, code AuthorizationFailed. Client,' +
    ' object and subscription IDs are replaced.',
  code: 'AuthorizationFailed',
  httpStatus: 403,
  message:
    "The client '<client-id>' with object id '<object-id>' does not have authorization to perform action 'Microsoft.Storage/storageAccounts/read' over scope '/subscriptions/<subscription-id>' or the scope is invalid. If access was recently granted, please refresh your credentials.",
  action: 'Microsoft.Storage/storageAccounts/read',
};

/** Compute Engine denying a service account one IAM permission. */
export const GCP_PERMISSION_DENIED: PermissionDenialPersona = {
  provenance:
    'Quoted from gcloud compute instances create (HTTP 403) in the Linux' +
    ' Foundation forum (https://forum.linuxfoundation.org/discussion/comment/20747,' +
    ' accessed 2026-10-09). Project and instance names are replaced.',
  code: 'PERMISSION_DENIED',
  httpStatus: 403,
  message:
    "Required 'compute.instances.create' permission for 'projects/<project>/zones/us-central1-f/instances/<instance>'",
  action: 'compute.instances.create',
};
