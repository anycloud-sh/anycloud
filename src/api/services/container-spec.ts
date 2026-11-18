import type { DockerOptions } from '../../shared/runtime.js';
import { decryptSecret, encryptSecret } from './secret-crypto.js';

/** Private container values. The resource, not this representation, owns mutability. */
export interface ContainerSpec {
  image: string;
  imageDigest: string | null;
  command: string[] | null;
  dockerOptions: DockerOptions | null;
  env: Record<string, string> | null;
  registryUsername: string;
  registryToken: string | null;
  /** A managed Deployment's image Entrypoint, which its runner starts. */
  entrypoint?: string[];
}

/** SQL values only; identity and owner references stay with their repositories. */
export interface EncodedContainerSpec {
  image: string;
  image_digest: string | null;
  command: string | null;
  docker_options: string | null;
  env: string | null;
  registry_username: string;
  registry_token: string | null;
  entrypoint?: string | null;
}

export type PublicContainerSpec = Pick<
  ContainerSpec,
  'image' | 'imageDigest' | 'command' | 'dockerOptions'
>;
type ServiceContainerUpdate = Pick<
  ContainerSpec,
  'image' | 'imageDigest' | 'command' | 'env' | 'registryToken'
> &
  Partial<Pick<ContainerSpec, 'dockerOptions'>>;

function invalid(context: string, field: string): never {
  // Never include the value or a parser/crypto exception: either may hold secrets.
  throw new Error(`${context}: invalid ${field}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((part) => typeof part === 'string')
  );
}

/** Lossless stored-shape checks, deliberately separate from admission policy. */
function validateImageFields(
  spec: Pick<ContainerSpec, 'image' | 'imageDigest' | 'command'>,
  context: string,
): void {
  if (typeof spec.image !== 'string' || !spec.image.trim()) {
    invalid(context, 'image');
  }
  if (spec.imageDigest !== null && typeof spec.imageDigest !== 'string') {
    invalid(context, 'imageDigest');
  }
  if (spec.command !== null && !isStringArray(spec.command)) {
    invalid(context, 'command');
  }
}

function validateSecretFields(
  spec: Pick<ContainerSpec, 'env' | 'registryToken'>,
  context: string,
): void {
  if (
    spec.env !== null &&
    (!isRecord(spec.env) ||
      Object.values(spec.env).some((value) => typeof value !== 'string'))
  ) {
    invalid(context, 'env');
  }
  if (spec.registryToken !== null && typeof spec.registryToken !== 'string') {
    invalid(context, 'registryToken');
  }
}

function validatePublicFields(
  spec: PublicContainerSpec,
  context: string,
): void {
  validateImageFields(spec, context);
  if (spec.dockerOptions !== null) {
    if (!isRecord(spec.dockerOptions)) invalid(context, 'dockerOptions');
    const stringFields = new Set([
      'shmSize',
      'gpus',
      'ipc',
      'memory',
      'cpus',
      'runtime',
      'network',
    ]);
    for (const [key, value] of Object.entries(spec.dockerOptions)) {
      if (
        (key === 'privileged' || key === 'userNamespace') &&
        typeof value === 'boolean'
      )
        continue;
      if (stringFields.has(key) && typeof value === 'string') continue;
      if (
        (key === 'ulimits' || key === 'binds' || key === 'caches') &&
        isStringArray(value)
      )
        continue;
      invalid(context, 'dockerOptions');
    }
  }
}

/** Lossless stored-shape checks, deliberately separate from admission policy. */
function validateContainerSpec(
  spec: ContainerSpec,
  context = 'Container spec',
): void {
  validatePublicFields(spec, context);
  validateSecretFields(spec, context);
  // An explicitly empty username has different semantics from an omitted one.
  if (typeof spec.registryUsername !== 'string') {
    invalid(context, 'registryUsername');
  }
}

/** Service upgrades preserve options unless explicitly replaced; identity stays put. */
export async function encodeServiceContainerUpdate(
  spec: ServiceContainerUpdate,
  context = 'Container spec',
): Promise<
  Pick<
    EncodedContainerSpec,
    'image' | 'image_digest' | 'command' | 'env' | 'registry_token'
  > &
    Partial<Pick<EncodedContainerSpec, 'docker_options'>>
> {
  validatePublicFields(
    { ...spec, dockerOptions: spec.dockerOptions ?? null },
    context,
  );
  validateSecretFields(spec, context);
  return {
    ...(await encodeServiceFields(spec)),
    ...(spec.dockerOptions === undefined
      ? {}
      : {
          docker_options:
            spec.dockerOptions === null
              ? null
              : JSON.stringify(spec.dockerOptions),
        }),
  };
}

async function encodeServiceFields(
  spec: ServiceContainerUpdate,
): Promise<
  Pick<
    EncodedContainerSpec,
    'image' | 'image_digest' | 'command' | 'env' | 'registry_token'
  >
> {
  const [env, registryToken] = await Promise.all([
    spec.env === null ? null : encryptSecret(JSON.stringify(spec.env)),
    spec.registryToken === null ? null : encryptSecret(spec.registryToken),
  ]);
  return {
    image: spec.image,
    image_digest: spec.imageDigest,
    command: spec.command === null ? null : JSON.stringify(spec.command),
    env,
    registry_token: registryToken,
  };
}

export async function encodeContainerSpec(
  spec: ContainerSpec,
  context = 'Container spec',
): Promise<EncodedContainerSpec> {
  validateContainerSpec(spec, context);
  const [update, registryUsername] = await Promise.all([
    encodeServiceFields(spec),
    encryptSecret(spec.registryUsername),
  ]);
  return {
    ...update,
    docker_options:
      spec.dockerOptions === null ? null : JSON.stringify(spec.dockerOptions),
    registry_username: registryUsername,
    ...(spec.entrypoint && { entrypoint: JSON.stringify(spec.entrypoint) }),
  };
}

/** Store `spec` for its one owner, a Workload or a Deployment, in `tx`. */
export function insertContainerSpec(
  // A `DBTransaction`, which this module can't import without a cycle.
  tx: { query<T>(sql: string, params?: unknown[]): T[] },
  owner: { workloadId: string } | { deploymentId: string },
  spec: EncodedContainerSpec,
): void {
  const [column, id, noun] =
    'workloadId' in owner
      ? ['workload_id', owner.workloadId, 'Workload']
      : ['deployment_id', owner.deploymentId, 'Deployment'];
  const inserted = tx.query<{ rowsAffected: number }>(
    `INSERT INTO container_specs (
       ${column}, image, image_digest, command, docker_options, env,
       registry_username, registry_token, entrypoint
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      spec.image,
      spec.image_digest,
      spec.command,
      spec.docker_options,
      spec.env,
      spec.registry_username,
      spec.registry_token,
      spec.entrypoint ?? null,
    ],
  );
  if (inserted[0]?.rowsAffected !== 1) {
    throw new Error(
      `${noun} ${id}: expected exactly one container spec insert`,
    );
  }
}

/** Public listings capture only these plaintext columns, without reading secrets. */
export function decodePublicContainerSpec(
  row: Pick<
    EncodedContainerSpec,
    'image' | 'image_digest' | 'command' | 'docker_options'
  >,
  context = 'Container spec',
): PublicContainerSpec {
  const spec: PublicContainerSpec = {
    image: row.image,
    imageDigest: row.image_digest,
    command:
      row.command === null
        ? null
        : (parseJson(row.command, context, 'command') as string[]),
    dockerOptions:
      row.docker_options === null
        ? null
        : (parseJson(
            row.docker_options,
            context,
            'dockerOptions',
          ) as DockerOptions),
  };
  validatePublicFields(spec, context);
  return spec;
}

function parseJson(value: unknown, context: string, field: string): unknown {
  if (typeof value !== 'string') invalid(context, field);
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return invalid(context, field);
  }
}

async function decryptField(
  value: unknown,
  context: string,
  field: string,
): Promise<string> {
  if (typeof value !== 'string' || !value) invalid(context, field);
  try {
    return await decryptSecret(value);
  } catch {
    return invalid(context, field);
  }
}

/** Decrypt an already captured SQL snapshot; never issue another read here. */
export async function decodeContainerSpec(
  row: EncodedContainerSpec,
  context = 'Container spec',
): Promise<ContainerSpec> {
  const [env, registryUsername, registryToken] = await Promise.all([
    row.env === null ? null : decryptField(row.env, context, 'env'),
    decryptField(row.registry_username, context, 'registryUsername'),
    row.registry_token === null
      ? null
      : decryptField(row.registry_token, context, 'registryToken'),
  ]);
  const spec: ContainerSpec = {
    ...decodePublicContainerSpec(row, context),
    env:
      env === null
        ? null
        : (parseJson(env, context, 'env') as Record<string, string>),
    registryUsername,
    registryToken,
    ...(row.entrypoint && {
      entrypoint: parseJson(row.entrypoint, context, 'entrypoint') as string[],
    }),
  };
  validateSecretFields(spec, context);
  return spec;
}

/**
 * Every Workload owns a container spec except a Job on a user Deployment; a
 * pool Job on a managed Deployment owns its own (the schema enforces which).
 */
export function assertSpecOwnership(row: {
  id: string;
  deployment_id: string | null;
  container_spec_owner_id: string | null;
}): void {
  if (row.deployment_id === null && row.container_spec_owner_id === null) {
    throw new Error(
      `Workload ${row.id}: container spec ownership is incomplete`,
    );
  }
}
