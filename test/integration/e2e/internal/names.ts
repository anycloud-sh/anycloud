import { createHash } from 'node:crypto';

const MAX_RESOURCE_NAME_LENGTH = 28;
/** The fixture run id's length (context.ts); a workload ID's readable part gets what the 28 characters leave. */
export const RUN_ID_LENGTH = 10;
const NAME_HASH_LENGTH = 8;

type FixtureResourceScope = 'workload' | 'secret';

const scopeTag = {
  workload: 'd',
  secret: 's',
} as const satisfies Record<FixtureResourceScope, string>;

function normalizedPrefix(prefix: string): string {
  return (
    prefix
      .toLowerCase()
      .replace(/[^a-z0-9-]+/gu, '-')
      .replace(/^-+|-+$/gu, '') || 'e2e'
  );
}

export class FixtureNames {
  readonly #runId: string;
  readonly #allocated = new Map<string, string>();

  constructor(runId: string) {
    this.#runId = runId;
  }

  workload(prefix: string): string {
    return this.#allocate('workload', prefix);
  }

  secret(prefix: string): string {
    return this.#allocate('secret', prefix);
  }

  #allocate(scope: FixtureResourceScope, prefix: string): string {
    const normalized = normalizedPrefix(prefix);
    const logicalName = `${scope}:${normalized}`;
    const digest = createHash('sha256')
      .update(logicalName)
      .digest('hex')
      .slice(0, NAME_HASH_LENGTH);
    const prefixBudget =
      MAX_RESOURCE_NAME_LENGTH -
      scopeTag[scope].length -
      digest.length -
      this.#runId.length -
      /* separators */ 3;
    if (prefixBudget < 1) {
      throw new Error('E2E run ID leaves no room for a resource name prefix');
    }
    const readable = normalized.slice(0, prefixBudget).replace(/-+$/gu, '');
    const allocated = `${scopeTag[scope]}-${readable || 'e'}-${digest}-${this.#runId}`;
    const existing = this.#allocated.get(allocated);
    if (existing && existing !== logicalName) {
      throw new Error(
        `Fixture resource name collision between ${existing} and ${logicalName}`,
      );
    }
    this.#allocated.set(allocated, logicalName);
    return allocated;
  }
}
