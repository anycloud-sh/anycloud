import { createHash, randomUUID } from 'crypto';
import { validateGeneratedAzureCredentialName } from '../credential-onboarding/generated-credential-name.js';
import {
  azureCliTransport,
  type AzureDirectoryObject,
  type AzureDirectoryObjectKind,
  type AzureTransport,
  type AzureTransportCallOptions,
} from './azure-transport.js';
import { withRetry } from '../../../shared/utils.js';

/**
 * Generated service principal credentials
 */
export interface GeneratedAzureCredentials {
  applicationId: string;
  secret: string;
  secretExpiresAt?: string;
  tenantId: string;
  cleanup?: () => Promise<void>;
}

export interface AzureGenerationPreview {
  subscriptionId: string;
  tenantId: string;
  scope: string;
  roles: readonly ['Contributor'];
}

const AZURE_MANAGED_TAG = 'AnycloudManaged';
const AZURE_CREDENTIAL_TAG_PREFIX = 'AnycloudCredentialName:';
const AZURE_OPERATION_TAG_PREFIX = 'AnycloudOperation:';

const CONTRIBUTOR_ROLE_ID = 'b24988ac-6180-42a0-ab88-20f7382dd24c';

export async function getAzureGenerationPreview(
  subscriptionId: string,
  options: Pick<
    GenerateAzureServicePrincipalOptions,
    'signal' | 'transport'
  > = {},
): Promise<AzureGenerationPreview> {
  const tenantId = (
    await (options.transport ?? azureCliTransport).getSubscriptionTenant(
      subscriptionId,
      ...(options.signal ? [{ signal: options.signal }] : []),
    )
  ).trim();
  if (!tenantId) {
    throw new Error('Azure did not return the subscription tenant ID.');
  }
  return {
    subscriptionId,
    tenantId,
    scope: `/subscriptions/${subscriptionId}`,
    roles: ['Contributor'],
  };
}

export interface GenerateAzureServicePrincipalOptions {
  signal?: AbortSignal;
  roleAssignmentWaits?: number[];
  reconciliationWaits?: number[];
  directoryPropagationWaits?: number[];
  wait?: (milliseconds: number) => Promise<void>;
  operationId?: string;
  transport?: AzureTransport;
}

function azureErrorDetails(error: unknown): {
  code: string;
  message: string;
  statusCode?: number;
  requestId?: string;
} {
  const candidate = error as {
    name?: unknown;
    code?: unknown;
    statusCode?: unknown;
    requestId?: unknown;
    message?: unknown;
    details?: { error?: { code?: unknown } };
    response?: {
      headers?: { get?: (name: string) => string | null | undefined };
    };
  };
  const rawCode =
    candidate?.code ?? candidate?.details?.error?.code ?? candidate?.name ?? '';
  const headerRequestId =
    candidate?.response?.headers?.get?.('x-ms-request-id');
  const requestId =
    typeof candidate?.requestId === 'string'
      ? candidate.requestId
      : typeof headerRequestId === 'string'
        ? headerRequestId
        : undefined;
  return {
    code: typeof rawCode === 'string' ? rawCode : '',
    message:
      typeof candidate?.message === 'string'
        ? candidate.message
        : String(error),
    ...(typeof candidate?.statusCode === 'number'
      ? { statusCode: candidate.statusCode }
      : {}),
    ...(requestId ? { requestId } : {}),
  };
}

function deterministicGuid(...parts: string[]): string {
  const bytes = createHash('sha256')
    .update(parts.join('\0'))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function azureErrorText(error: unknown): string {
  const { code, message } = azureErrorDetails(error);
  return `${code} ${message}`;
}

function isMissingAzureResource(error: unknown): boolean {
  return /could not be found|does not exist|not found|ResourceNotFound|RoleAssignmentNotFound|Request_ResourceNotFound/i.test(
    azureErrorText(error),
  );
}

function isAmbiguousAzureRequest(error: unknown): boolean {
  if (
    typeof error === 'object' &&
    error !== null &&
    'mayHaveSucceeded' in error &&
    error.mayHaveSucceeded === true
  ) {
    return true;
  }
  return /ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|connection (?:closed|reset)|timed? out|RequestTimeout|InternalServerError|ServiceUnavailable/i.test(
    azureErrorText(error),
  );
}

function isAzureDirectoryPropagationFailure(error: unknown): boolean {
  const text = azureErrorText(error);
  return (
    isMissingAzureResource(error) ||
    /Authorization_RequestDenied|Insufficient privileges|Forbidden/i.test(text)
  );
}

export class AzurePermissionError extends Error {
  name = 'AzurePermissionError';
}

/**
 * Generate an owned Azure application, service principal, client secret, and
 * mandatory Contributor role assignment.
 */
export async function generateAzureServicePrincipal(
  subscriptionId: string,
  name: string,
  options: GenerateAzureServicePrincipalOptions = {},
): Promise<GeneratedAzureCredentials> {
  validateGeneratedAzureCredentialName(name);
  const transport = options.transport ?? azureCliTransport;
  const spName = `anycloud-${name}`;
  const scope = `/subscriptions/${subscriptionId}`;
  const operationId = options.operationId ?? randomUUID();
  const tags = [
    AZURE_MANAGED_TAG,
    `${AZURE_CREDENTIAL_TAG_PREFIX}${name}`,
    `${AZURE_OPERATION_TAG_PREFIX}${operationId}`,
  ];
  const waits = options.roleAssignmentWaits ?? [500, 1_000, 2_000, 4_000];
  const reconciliationWaits = options.reconciliationWaits ?? [250, 500, 1_000];
  const directoryPropagationWaits = options.directoryPropagationWaits ?? [
    500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000,
  ];
  const wait =
    options.wait ??
    ((milliseconds: number) =>
      new Promise<void>((done) => setTimeout(done, milliseconds)));
  // withRetry options for an explicit schedule through the injectable wait.
  const schedule = (delays: readonly number[]) => ({
    maxAttempts: delays.length + 1,
    retryDelayMs: (_error: unknown, attempt: number) => delays[attempt - 1],
    sleep: wait,
  });
  let stage = 'checking for existing directory objects';
  let applicationObjectId: string | undefined;
  let applicationId: string | undefined;
  let servicePrincipalObjectId: string | undefined;
  let applicationMayExist = false;
  let servicePrincipalMayExist = false;
  const roleAssignmentIds: string[] = [];
  type TransportOptions = [] | [AzureTransportCallOptions];
  const foregroundTransportOptions: TransportOptions = options.signal
    ? [{ signal: options.signal }]
    : [];

  const listExact = async (
    kind: AzureDirectoryObjectKind,
    transportOptions: TransportOptions = foregroundTransportOptions,
  ): Promise<AzureDirectoryObject[]> => {
    const objects = await transport.listDirectoryObjects(
      {
        kind,
        displayName: spName,
        subscriptionId,
      },
      ...transportOptions,
    );
    return objects.filter((object) => object.displayName === spName);
  };

  const reconcileOwnedObject = async (
    kind: AzureDirectoryObjectKind,
    transportOptions: TransportOptions = foregroundTransportOptions,
  ): Promise<AzureDirectoryObject | undefined> => {
    // An empty listing is retried like a failed one, then means none.
    const missing = new Error('not listed yet');
    const matches = await withRetry(
      async () => {
        const listed = await listExact(kind, transportOptions);
        if (listed.length === 0) throw missing;
        return listed;
      },
      `List the Azure ${kind}`,
      schedule(reconciliationWaits),
    ).catch((error: unknown) => {
      if (error === missing) return [];
      throw error;
    });
    if (matches.length === 0) return undefined;
    if (matches.length > 1) {
      throw new Error(
        `Azure returned multiple ${kind === 'application' ? 'applications' : 'service principals'} for operation ${operationId}.`,
      );
    }
    const object = matches[0];
    const ownershipTags = object.tags?.filter(
      (tag) =>
        tag === AZURE_MANAGED_TAG ||
        tag.startsWith(AZURE_CREDENTIAL_TAG_PREFIX) ||
        tag.startsWith(AZURE_OPERATION_TAG_PREFIX),
    );
    if (
      ownershipTags?.length !== tags.length ||
      !tags.every((tag) => ownershipTags.includes(tag))
    ) {
      throw new Error(
        `Refusing Azure ${kind === 'application' ? 'application' : 'service principal'} ${object.id ?? spName}: its ownership markers do not match operation ${operationId}.`,
      );
    }
    return object;
  };

  const createOwnedDirectoryObject = async (
    kind: AzureDirectoryObjectKind,
    body: Readonly<Record<string, unknown>>,
  ): Promise<AzureDirectoryObject> => {
    try {
      const object = await withRetry(
        () =>
          transport.createDirectoryObject(
            { kind, body, subscriptionId },
            ...foregroundTransportOptions,
          ),
        `Create the Azure ${kind}`,
        {
          ...schedule(directoryPropagationWaits),
          shouldRetry: (error) =>
            kind === 'servicePrincipal' &&
            isAzureDirectoryPropagationFailure(error),
        },
      );
      if (kind === 'application') applicationMayExist = true;
      else servicePrincipalMayExist = true;
      return object;
    } catch (error) {
      if (!isAmbiguousAzureRequest(error)) throw error;
      if (kind === 'application') applicationMayExist = true;
      else servicePrincipalMayExist = true;
      const reconciled = await reconcileOwnedObject(kind).catch(
        () => undefined,
      );
      if (!reconciled) throw error;
      return reconciled;
    }
  };

  const cleanupCreatedPrincipal = async (): Promise<string[]> => {
    const failures: string[] = [];
    const cleanup = async (operation: () => Promise<void>): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        const message = (error as Error).message;
        if (!isMissingAzureResource(error)) failures.push(message);
      }
    };

    const reconcileForCleanup = async (
      kind: AzureDirectoryObjectKind,
    ): Promise<void> => {
      try {
        const object = await reconcileOwnedObject(kind, []);
        if (!object?.id) {
          failures.push(
            `Could not verify whether the ownership-marked Azure ${kind === 'application' ? 'application' : 'service principal'} was created for operation ${operationId}.`,
          );
          return;
        }
        if (
          kind === 'servicePrincipal' &&
          applicationId &&
          object.appId !== applicationId
        ) {
          failures.push(
            `Refusing to delete Azure service principal ${object.id}: its application ID does not match operation ${operationId}.`,
          );
          return;
        }
        if (kind === 'application') {
          applicationObjectId = object.id;
          applicationId = object.appId;
        } else {
          servicePrincipalObjectId = object.id;
        }
      } catch (error) {
        failures.push(
          `Could not verify ownership of the Azure ${kind === 'application' ? 'application' : 'service principal'}: ${(error as Error).message}`,
        );
      }
    };

    if (servicePrincipalMayExist && !servicePrincipalObjectId) {
      await reconcileForCleanup('servicePrincipal');
    }
    if (applicationMayExist && !applicationObjectId) {
      await reconcileForCleanup('application');
    }
    for (const assignmentId of [...roleAssignmentIds].reverse()) {
      await cleanup(() =>
        transport.deleteRoleAssignment({
          assignmentResourceId: `${scope}/providers/Microsoft.Authorization/roleAssignments/${assignmentId}`,
          subscriptionId,
        }),
      );
    }
    // Keep the principal intact when assignment cleanup was denied. Its object
    // ID is required to find and remove orphaned assignments on a later retry.
    if (failures.length > 0) return failures;
    if (servicePrincipalObjectId) {
      const objectId = servicePrincipalObjectId;
      await cleanup(() =>
        transport.deleteDirectoryObject({
          kind: 'servicePrincipal',
          objectId,
          subscriptionId,
        }),
      );
    }
    if (failures.length > 0) return failures;
    if (applicationObjectId) {
      const objectId = applicationObjectId;
      await cleanup(() =>
        transport.deleteDirectoryObject({
          kind: 'application',
          objectId,
          subscriptionId,
        }),
      );
    }
    return failures;
  };

  const cleanupOrThrow = async (): Promise<void> => {
    const failures = await cleanupCreatedPrincipal();
    if (failures.length > 0) {
      throw new Error(
        `Failed to clean up the generated Azure identity: ${failures.join('; ')}`,
      );
    }
  };

  const createRoleAssignment = async (roleId: string): Promise<void> => {
    if (!servicePrincipalObjectId) {
      throw new Error('Azure did not return a service principal object ID.');
    }
    const assignmentId = deterministicGuid(
      scope,
      servicePrincipalObjectId,
      roleId,
    );
    roleAssignmentIds.push(assignmentId);
    const principalObjectId = servicePrincipalObjectId;
    await withRetry(
      () =>
        transport
          .createRoleAssignment(
            { assignmentId, principalObjectId, roleId, scope, subscriptionId },
            ...foregroundTransportOptions,
          )
          .catch((error: unknown) => {
            if (!/RoleAssignmentExists/i.test(azureErrorText(error)))
              throw error;
          }),
      'Assign the Azure role',
      {
        ...schedule(waits),
        shouldRetry: (error) =>
          /PrincipalNotFound|DirectoryObjectNotFound|does not exist in the directory|not found in (?:the )?directory/i.test(
            azureErrorText(error),
          ),
      },
    );
  };

  try {
    // Keep these checks sequential. Besides avoiding unnecessary Azure CLI
    // contention, this makes the preflight deterministic for callers that
    // serialize access to a shared CLI profile.
    const existingPrincipals = await listExact('servicePrincipal');
    const existingApplications = await listExact('application');
    if (existingPrincipals.length > 0 || existingApplications.length > 0) {
      throw new Error(
        `Azure identity "${spName}" already exists. Please use a different name or delete every matching application and service principal.`,
      );
    }

    stage = 'creating the Entra application';
    const applicationBody = {
      displayName: spName,
      signInAudience: 'AzureADMyOrg',
      tags,
    };
    const application = await createOwnedDirectoryObject(
      'application',
      applicationBody,
    );
    if (!application.id || !application.appId) {
      throw new Error(
        'Azure did not return application object and client IDs.',
      );
    }
    applicationObjectId = application.id;
    applicationId = application.appId;

    stage = 'creating the Entra service principal';
    const principalBody = { appId: applicationId, tags };
    const principal = await createOwnedDirectoryObject(
      'servicePrincipal',
      principalBody,
    );
    if (!principal.id || principal.appId !== applicationId) {
      throw new Error(
        'Azure did not return the expected service principal object ID.',
      );
    }
    servicePrincipalObjectId = principal.id;

    stage = 'creating the application client secret';
    const credentialBody = {
      passwordCredential: {
        displayName: `Anycloud generated credential ${operationId}`,
      },
    };
    const passwordTarget = applicationObjectId;
    const credential = await withRetry(
      () =>
        transport.addApplicationPassword(
          {
            applicationObjectId: passwordTarget,
            body: credentialBody,
            subscriptionId,
          },
          ...foregroundTransportOptions,
        ),
      'Add the Azure application password',
      {
        ...schedule(directoryPropagationWaits),
        shouldRetry: (error) =>
          isAzureDirectoryPropagationFailure(error) ||
          // Graph has answered a just-created application's addPassword
          // this way once; a later run of the same flow succeeded.
          azureErrorDetails(error).message ===
            'Unable to read the company information from the directory.',
      },
    );

    stage = 'granting the Contributor role';
    await createRoleAssignment(CONTRIBUTOR_ROLE_ID);

    stage = 'reading the subscription tenant';
    const { tenantId } = await getAzureGenerationPreview(subscriptionId, {
      transport,
      ...(options.signal ? { signal: options.signal } : {}),
    });

    return {
      applicationId,
      secret: credential.secretText,
      ...(typeof credential.endDateTime === 'string'
        ? { secretExpiresAt: credential.endDateTime }
        : {}),
      tenantId,
      cleanup: cleanupOrThrow,
    };
  } catch (error) {
    const errorMessage = azureErrorDetails(error).message;
    const errorText = azureErrorText(error);
    const cleanupFailures = await cleanupCreatedPrincipal();
    const cleanupSuffix = cleanupFailures.length
      ? ` Cleanup also failed: ${cleanupFailures.join('; ')}`
      : '';

    if (
      /Authorization_RequestDenied|Insufficient privileges|AuthorizationFailed|does not have authorization|Forbidden/i.test(
        errorText,
      )
    ) {
      const requiredPermission = stage.includes('role')
        ? 'Azure RBAC roleAssignments/write and roleAssignments/delete permissions at the subscription scope'
        : 'the admin-consented Microsoft Graph Application.ReadWrite.OwnedBy application permission (or Application.ReadWrite.All) to create and delete owned applications and service principals';
      throw Object.assign(
        new AzurePermissionError(
          `Azure permission denied while ${stage}. The bootstrap identity needs ${requiredPermission}. Original failure: ${errorMessage}${cleanupSuffix}`,
        ),
        { cause: error },
      );
    }

    if (/subscription.*does not exist|SubscriptionNotFound/i.test(errorText)) {
      throw Object.assign(
        new Error(
          `Subscription ${subscriptionId} not found. Please verify your subscription ID. Original failure: ${errorMessage}${cleanupSuffix}`,
        ),
        { cause: error },
      );
    }

    throw Object.assign(
      new Error(`Failed while ${stage}: ${errorMessage}${cleanupSuffix}`),
      { cause: error },
    );
  }
}
