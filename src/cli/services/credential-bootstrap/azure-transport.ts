import { AzureCliCommandError, runAzureCli } from './azure-cli-runner.js';

export type AzureDirectoryObjectKind = 'application' | 'servicePrincipal';

export interface AzureDirectoryObject {
  id?: string;
  appId?: string;
  displayName?: string;
  tags?: string[];
}

interface AzureApplicationPassword {
  secretText: string;
  endDateTime?: string;
}

export interface AzureTransportCallOptions {
  signal?: AbortSignal;
}

interface AzureDirectoryObjectRequest {
  kind: AzureDirectoryObjectKind;
  subscriptionId: string;
}

export interface AzureTransport {
  listDirectoryObjects(
    request: AzureDirectoryObjectRequest & { displayName: string },
    options?: AzureTransportCallOptions,
  ): Promise<AzureDirectoryObject[]>;
  createDirectoryObject(
    request: AzureDirectoryObjectRequest & {
      body: Readonly<Record<string, unknown>>;
    },
    options?: AzureTransportCallOptions,
  ): Promise<AzureDirectoryObject>;
  deleteDirectoryObject(
    request: AzureDirectoryObjectRequest & { objectId: string },
    options?: AzureTransportCallOptions,
  ): Promise<void>;
  addApplicationPassword(
    request: {
      applicationObjectId: string;
      body: Readonly<Record<string, unknown>>;
      subscriptionId: string;
    },
    options?: AzureTransportCallOptions,
  ): Promise<AzureApplicationPassword>;
  createRoleAssignment(
    request: {
      assignmentId: string;
      principalObjectId: string;
      roleId: string;
      scope: string;
      subscriptionId: string;
    },
    options?: AzureTransportCallOptions,
  ): Promise<void>;
  deleteRoleAssignment(
    request: {
      assignmentResourceId: string;
      subscriptionId: string;
    },
    options?: AzureTransportCallOptions,
  ): Promise<void>;
  getSubscriptionTenant(
    subscriptionId: string,
    options?: AzureTransportCallOptions,
  ): Promise<string>;
}

function graphCollection(kind: AzureDirectoryObjectKind): string {
  return kind === 'application' ? 'applications' : 'servicePrincipals';
}

function run(
  args: readonly string[],
  options?: AzureTransportCallOptions,
): Promise<string> {
  return options?.signal
    ? runAzureCli(args, { signal: options.signal })
    : runAzureCli(args);
}

function invalidOutput(
  description: string,
  mayHaveSucceeded: boolean,
): AzureCliCommandError {
  return new AzureCliCommandError(
    `Azure CLI returned invalid ${description} output.`,
    { code: 'AZURE_CLI_INVALID_OUTPUT', mayHaveSucceeded },
  );
}

function parseJson(
  output: string,
  description: string,
  mayHaveSucceeded: boolean,
): unknown {
  try {
    return JSON.parse(output);
  } catch {
    throw invalidOutput(description, mayHaveSucceeded);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeDirectoryObject(
  value: unknown,
  description: string,
  mayHaveSucceeded: boolean,
  requireIds: boolean,
): AzureDirectoryObject {
  if (!isRecord(value)) throw invalidOutput(description, mayHaveSucceeded);
  const { id, appId, displayName, tags } = value;
  if (
    (id !== undefined && id !== null && typeof id !== 'string') ||
    (appId !== undefined && appId !== null && typeof appId !== 'string') ||
    (displayName !== undefined &&
      displayName !== null &&
      typeof displayName !== 'string') ||
    (tags !== undefined &&
      tags !== null &&
      (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string'))) ||
    (requireIds &&
      (typeof id !== 'string' ||
        id.length === 0 ||
        typeof appId !== 'string' ||
        appId.length === 0))
  ) {
    throw invalidOutput(description, mayHaveSucceeded);
  }
  return {
    ...(typeof id === 'string' ? { id } : {}),
    ...(typeof appId === 'string' ? { appId } : {}),
    ...(typeof displayName === 'string' ? { displayName } : {}),
    ...(Array.isArray(tags) ? { tags: [...tags] as string[] } : {}),
  };
}

function decodeDirectoryObjects(output: string): AzureDirectoryObject[] {
  const value = parseJson(output, 'directory-object list', false);
  if (!Array.isArray(value)) {
    throw invalidOutput('directory-object list', false);
  }
  return value.map((object) =>
    decodeDirectoryObject(object, 'directory-object list', false, false),
  );
}

function decodeCreatedDirectoryObject(output: string): AzureDirectoryObject {
  return decodeDirectoryObject(
    parseJson(output, 'created directory object', true),
    'created directory object',
    true,
    true,
  );
}

function decodeApplicationPassword(output: string): AzureApplicationPassword {
  const value = parseJson(output, 'generated application password', true);
  if (!isRecord(value)) {
    throw invalidOutput('generated application password', true);
  }
  const { secretText, endDateTime } = value;
  if (
    typeof secretText !== 'string' ||
    secretText.length === 0 ||
    (endDateTime !== undefined &&
      endDateTime !== null &&
      typeof endDateTime !== 'string')
  ) {
    throw invalidOutput('generated application password', true);
  }
  return {
    secretText,
    ...(typeof endDateTime === 'string' ? { endDateTime } : {}),
  };
}

function decodeTenant(output: string): string {
  const value = parseJson(output, 'subscription tenant', false);
  if (typeof value !== 'string' || value.length === 0) {
    throw invalidOutput('subscription tenant', false);
  }
  return value;
}

/** Azure CLI adapter for generated credential acquisition. */
export const azureCliTransport: AzureTransport = {
  async listDirectoryObjects({ kind, displayName, subscriptionId }, options) {
    const escapedDisplayName = displayName.replace(/'/g, "''");
    const displayNameFilter = `displayName eq '${escapedDisplayName}'`;
    const url =
      `https://graph.microsoft.com/v1.0/${graphCollection(kind)}` +
      `?$filter=${encodeURIComponent(displayNameFilter)}` +
      '&$select=id,appId,displayName,tags';
    const output = await run(
      [
        'rest',
        '--method',
        'GET',
        '--url',
        url,
        '--subscription',
        subscriptionId,
        '--query',
        'value',
        '--output',
        'json',
        '--only-show-errors',
      ],
      options,
    );
    return decodeDirectoryObjects(output);
  },

  async createDirectoryObject({ kind, body, subscriptionId }, options) {
    const url = `https://graph.microsoft.com/v1.0/${graphCollection(kind)}`;
    const output = await run(
      [
        'rest',
        '--method',
        'POST',
        '--url',
        url,
        '--body',
        JSON.stringify(body),
        '--subscription',
        subscriptionId,
        '--output',
        'json',
        '--only-show-errors',
      ],
      options,
    );
    return decodeCreatedDirectoryObject(output);
  },

  async deleteDirectoryObject({ kind, objectId, subscriptionId }, options) {
    const url =
      `https://graph.microsoft.com/v1.0/${graphCollection(kind)}/` + objectId;
    await run(
      [
        'rest',
        '--method',
        'DELETE',
        '--url',
        url,
        '--subscription',
        subscriptionId,
        '--output',
        'none',
        '--only-show-errors',
      ],
      options,
    );
  },

  async addApplicationPassword(
    { applicationObjectId, body, subscriptionId },
    options,
  ) {
    const url = `https://graph.microsoft.com/v1.0/applications/${applicationObjectId}/addPassword`;
    const output = await run(
      [
        'rest',
        '--method',
        'POST',
        '--url',
        url,
        '--body',
        JSON.stringify(body),
        '--subscription',
        subscriptionId,
        '--output',
        'json',
        '--only-show-errors',
      ],
      options,
    );
    return decodeApplicationPassword(output);
  },

  async createRoleAssignment(
    { assignmentId, principalObjectId, roleId, scope, subscriptionId },
    options,
  ) {
    await run(
      [
        'role',
        'assignment',
        'create',
        '--name',
        assignmentId,
        '--assignee-object-id',
        principalObjectId,
        '--assignee-principal-type',
        'ServicePrincipal',
        '--role',
        roleId,
        '--scope',
        scope,
        '--subscription',
        subscriptionId,
        '--output',
        'none',
        '--only-show-errors',
      ],
      options,
    );
  },

  async deleteRoleAssignment(
    { assignmentResourceId, subscriptionId },
    options,
  ) {
    await run(
      [
        'role',
        'assignment',
        'delete',
        '--ids',
        assignmentResourceId,
        '--subscription',
        subscriptionId,
        '--output',
        'none',
        '--only-show-errors',
      ],
      options,
    );
  },

  async getSubscriptionTenant(subscriptionId, options) {
    const output = await run(
      [
        'account',
        'show',
        '--subscription',
        subscriptionId,
        '--query',
        'tenantId',
        '--output',
        'json',
        '--only-show-errors',
      ],
      options,
    );
    return decodeTenant(output);
  },
};
