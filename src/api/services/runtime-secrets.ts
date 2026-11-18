import { createHash } from 'node:crypto';
import { InvalidAnycloudConfigError } from '../../shared/errors.js';
import { shellEscape } from '../../shared/utils.js';

export const RUNTIME_SECRETS_DIR = '/run/anycloud-secrets';
export const RUNTIME_SECRETS_ENV_FILE = `${RUNTIME_SECRETS_DIR}/env`;

/** One named Secret as a container start or a live delivery writes it. */
export interface RuntimeSecret {
  readonly name: string;
  /** Changes on every save and reveals nothing about the values. */
  readonly revision: string;
  readonly values: Record<string, string>;
}

/** The host commands that write a Secret's files. */
interface SecretFileHost {
  exec(
    command: string,
    commandTimeoutMs?: number,
    maxAttempts?: number,
  ): Promise<{ stdout: string }>;
  writeFile(
    path: string,
    content: string,
    options: { mode: number; directoryMode: number },
  ): Promise<void>;
}

/** The first 16 hex characters of the SHA-256 of the stored ciphertext. */
export function secretRevision(encryptedValues: string): string {
  return createHash('sha256')
    .update(encryptedValues)
    .digest('hex')
    .slice(0, 16);
}

function assertValidRuntimeSecretValue(key: string, value: string): void {
  if (/[\r\n\0]/.test(value)) {
    throw new InvalidAnycloudConfigError(
      `Secret value for "${key}" contains a disallowed control character`,
    );
  }
}

export function serializeRuntimeSecretsEnv(
  values: Record<string, string>,
): string {
  const lines: string[] = [];
  for (const key of Object.keys(values)) {
    const value = values[key];
    assertValidRuntimeSecretValue(key, value);
    lines.push(`${key}=${value}`);
  }

  return lines.join('\n');
}

/**
 * The revision each Secret's `files/<name>` symlink names on the host, or
 * null where it is missing (a new host, or `/run` cleared by a reboot).
 */
export async function readSecretFileRevisions(
  host: SecretFileHost,
  names: readonly string[],
  root = RUNTIME_SECRETS_DIR,
): Promise<Map<string, string | null>> {
  // One attempt: the next poll is the retry, so an unreachable host costs
  // one connect timeout instead of holding the poll through SSH retries.
  const { stdout } = await host.exec(
    names
      .map(
        (name) =>
          `printf '%s\\n' "$(readlink ${shellEscape(`${root}/files/${name}`)})"`,
      )
      .join('; '),
    undefined,
    1,
  );
  const targets = stdout.split('\n');
  return new Map(
    names.map((name, index) => {
      const prefix = `.${name}.`;
      const target = targets[index] ?? '';
      return [
        name,
        target.startsWith(prefix) ? target.slice(prefix.length) : null,
      ];
    }),
  );
}

/**
 * Write one Secret's keys as `files/.<name>.<revision>/<KEY>` (0444 in a 0755
 * directory), then swap `files/<name>` to it in one rename and remove older
 * revisions. A reader sees all old keys or all new ones. Bytes travel only
 * through `writeFile`; no command carries a value.
 */
export async function writeSecretFiles(
  host: SecretFileHost,
  secret: RuntimeSecret,
  root = RUNTIME_SECRETS_DIR,
): Promise<void> {
  const files = `${root}/files`;
  const directory = `.${secret.name}.${secret.revision}`;
  await host.exec(
    `install -d -m 0700 ${shellEscape(root)} && install -d -m 0755 ${shellEscape(files)}`,
  );
  for (const [key, value] of Object.entries(secret.values)) {
    assertValidRuntimeSecretValue(key, value);
    await host.writeFile(`${files}/${directory}/${key}`, value, {
      mode: 0o444,
      directoryMode: 0o755,
    });
  }
  const link = shellEscape(secret.name);
  await host.exec(
    [
      `cd ${shellEscape(files)}`,
      `ln -sfn ${shellEscape(directory)} ${shellEscape(`${secret.name}.new`)}`,
      `mv -T ${shellEscape(`${secret.name}.new`)} ${link}`,
      `find . -maxdepth 1 -name ${shellEscape(`.${secret.name}.*`)} ! -name ${shellEscape(directory)} -exec rm -rf -- {} +`,
    ].join(' && '),
  );
}
