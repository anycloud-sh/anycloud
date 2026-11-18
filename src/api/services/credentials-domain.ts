import {
  cloudCredentialSchema,
  parseSavedCredential,
  type RedactedCredential,
  type RoleConnection,
  type RoleConnectionRequest,
  type SaveCredentialInput,
  type SavedCredential,
  type UpdateCredentialInput,
} from '../../shared/api-contract/credentials-schemas.js';
import {
  CredentialChangedError,
  CredentialInUseError,
} from '../../shared/errors.js';
import { CloudType } from '../../shared/cloud.js';

export class CredentialNotFoundError extends Error {
  constructor(public readonly credentialName: string) {
    super(`Credential "${credentialName}" not found`);
    this.name = 'CredentialNotFoundError';
  }
}

export class InvalidCredentialUpdateError extends Error {
  constructor(
    public readonly credentialName: string,
    message: string,
  ) {
    super(message);
    this.name = 'InvalidCredentialUpdateError';
  }
}

/** A cloud refused a role connection's exchange; the message says why. */
export class RoleConnectionCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleConnectionCheckError';
  }
}

/** The cloud has not granted the check yet, or throttled it; repeat the save. */
export class RoleConnectionPendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleConnectionPendingError';
  }
}

export class RoleConnectionRefusedError extends Error {
  constructor(
    public readonly credentialName: string,
    reason: string,
  ) {
    super(`Role connection "${credentialName}" was not saved: ${reason}`);
    this.name = 'RoleConnectionRefusedError';
  }
}

export interface CredentialsDomain {
  list(signal?: AbortSignal): Promise<RedactedCredential[]>;
  get(name: string, signal?: AbortSignal): Promise<RedactedCredential>;
  save(input: SaveCredentialInput, signal?: AbortSignal): Promise<void>;
  /** Merges the changed fields into the stored credential. */
  update(input: UpdateCredentialInput, signal?: AbortSignal): Promise<void>;
  delete(name: string, force: boolean, signal?: AbortSignal): Promise<void>;
}

/** The named-credential rows this domain reads and writes, still encrypted. */
interface NamedCredentialStore {
  listNamedCredentials(): Promise<
    { name: string; encryptedData: string; authFailedAt: number | null }[]
  >;
  getNamedCredential(name: string): Promise<{
    id: string;
    encryptedData: string;
    authFailedAt: number | null;
  } | null>;
  saveNamedCredential(
    name: string,
    credentialId: string,
    encryptedData: string,
    cloudProvider: CloudType,
    options?: { overwrite?: boolean; expectedId?: string },
  ): Promise<string>;
  clearCredentialAuthFailed(credentialId: string): Promise<void>;
  deleteNamedCredentialIfNotReferenced(
    name: string,
    force: boolean,
  ): Promise<{ deleted: boolean; blocking: string[] }>;
}

export interface CredentialsDomainDependencies {
  /** Back the database up now, so `backup.json` lists the credential. */
  requestBackup?(reason: string): void;
  store: NamedCredentialStore;
  decrypt(token: string): Promise<unknown>;
  encrypt(credential: SavedCredential): Promise<string>;
  hash(credential: SavedCredential): string;
  /**
   * Performs a role connection's exchange once and returns what to store;
   * null on a local API, which has no ServiceAccount token to exchange.
   */
  checkRoleConnection:
    | ((
        request: RoleConnectionRequest,
        signal?: AbortSignal,
      ) => Promise<RoleConnection>)
    | null;
}

function redactCredential(
  name: string,
  credential: SavedCredential,
  authFailedAt: number | null,
): RedactedCredential {
  const marker = authFailedAt == null ? {} : { authFailedAt };
  if ('kind' in credential) {
    // Its identifiers are not secret; the trust it was checked with is not shown.
    const {
      issuer: _,
      audience: __,
      subject: ___,
      ...identifiers
    } = credential;
    return { name, ...identifiers, ...marker };
  }
  switch (credential.cloudProvider) {
    case CloudType.AWS:
      return {
        name,
        cloudProvider: credential.cloudProvider,
        accessKeyId: credential.accessKeyId,
        ...marker,
      };
    case CloudType.GCP:
      return {
        name,
        cloudProvider: credential.cloudProvider,
        projectId: credential.projectId,
        clientEmail: credential.clientEmail,
        ...marker,
      };
    case CloudType.Azure:
      return {
        name,
        cloudProvider: credential.cloudProvider,
        subscriptionId: credential.subscriptionId,
        applicationId: credential.applicationId,
        ...marker,
      };
    case CloudType.Lambda:
      return { name, cloudProvider: credential.cloudProvider, ...marker };
    case CloudType.Cloudflare:
      return {
        name,
        cloudProvider: credential.cloudProvider,
        accountId: credential.accountId,
        ...(credential.jurisdiction
          ? { jurisdiction: credential.jurisdiction }
          : {}),
        ...marker,
      };
  }
}

export function createCredentialsDomain(
  dependencies: CredentialsDomainDependencies,
): CredentialsDomain {
  async function load(name: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const row = await dependencies.store.getNamedCredential(name);
    if (!row) throw new CredentialNotFoundError(name);
    const credential = parseSavedCredential(
      await dependencies.decrypt(row.encryptedData),
    );
    signal?.throwIfAborted();
    return { row, credential };
  }

  async function checkRoleConnection(
    name: string,
    request: RoleConnectionRequest,
    signal?: AbortSignal,
  ): Promise<RoleConnection> {
    if (!dependencies.checkRoleConnection)
      throw new RoleConnectionRefusedError(
        name,
        'a local API has no ServiceAccount token to exchange. Save a key, or connect the role to a self-hosted API.',
      );
    try {
      return await dependencies.checkRoleConnection(request, signal);
    } catch (error) {
      if (error instanceof RoleConnectionCheckError)
        throw new RoleConnectionRefusedError(name, error.message);
      throw error;
    }
  }

  return {
    async list(signal) {
      signal?.throwIfAborted();
      const entries = await dependencies.store.listNamedCredentials();
      const credentials = await Promise.all(
        entries.map(async (entry) =>
          redactCredential(
            entry.name,
            parseSavedCredential(
              await dependencies.decrypt(entry.encryptedData),
            ),
            entry.authFailedAt,
          ),
        ),
      );
      signal?.throwIfAborted();
      return credentials;
    },

    async get(name, signal) {
      const { row, credential } = await load(name, signal);
      return redactCredential(name, credential, row.authFailedAt);
    },

    async save(input, signal) {
      signal?.throwIfAborted();
      const { name, overwrite: _overwrite, ...request } = input;
      const credential =
        'kind' in request
          ? await checkRoleConnection(name, request, signal)
          : request;
      const credentialId = dependencies.hash(credential);
      const store = dependencies.store;
      if (!input.overwrite) {
        const existing = await store.getNamedCredential(input.name);
        if (existing?.id === credentialId) {
          await store.clearCredentialAuthFailed(credentialId);
          return;
        }
      }
      const encrypted = await dependencies.encrypt(credential);
      await store.saveNamedCredential(
        input.name,
        credentialId,
        encrypted,
        credential.cloudProvider,
        { overwrite: input.overwrite },
      );
      await store.clearCredentialAuthFailed(credentialId);
      dependencies.requestBackup?.(`credential ${name} saved`);
      signal?.throwIfAborted();
    },

    async update({ name, fields }, signal) {
      const { row, credential } = await load(name, signal);
      const parsed = cloudCredentialSchema.safeParse({
        ...credential,
        ...fields,
      });
      if (!parsed.success) {
        const fields = parsed.error.issues
          .flatMap((issue) =>
            issue.code === 'unrecognized_keys' ? issue.keys : issue.path,
          )
          .map(String);
        throw new InvalidCredentialUpdateError(
          name,
          'kind' in credential
            ? `${credential.cloudProvider} credential "${name}" is a role connection, which has no editable fields; save it again instead`
            : `${credential.cloudProvider} credential "${name}" has no ${fields.join(', ')} field`,
        );
      }
      const merged = parsed.data;
      const credentialId = dependencies.hash(merged);
      const store = dependencies.store;
      try {
        // Replace only the row this edit read, so a concurrent edit or delete
        // is not overwritten or undone.
        await store.saveNamedCredential(
          name,
          credentialId,
          await dependencies.encrypt(merged),
          merged.cloudProvider,
          { expectedId: row.id },
        );
      } catch (error) {
        if (
          error instanceof CredentialChangedError &&
          !(await store.getNamedCredential(name))
        )
          throw new CredentialNotFoundError(name);
        throw error;
      }
      await store.clearCredentialAuthFailed(credentialId);
      dependencies.requestBackup?.(`credential ${name} saved`);
      signal?.throwIfAborted();
    },

    async delete(name, force, signal) {
      signal?.throwIfAborted();
      const { blocking } =
        await dependencies.store.deleteNamedCredentialIfNotReferenced(
          name,
          force,
        );
      signal?.throwIfAborted();
      if (blocking.length > 0) throw new CredentialInUseError(name, blocking);
    },
  };
}
