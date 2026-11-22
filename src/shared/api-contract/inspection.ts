import {
  getContractRouter,
  isContractProcedure,
  type AnySchema,
} from '@orpc/contract';
import { apiContractMetaSchema, type ApiContractMeta } from './base.js';
import { apiContract } from './contract.js';

export interface ApiContractErrorDefinition {
  code: string;
  status: number;
  message: string;
  data?: AnySchema;
}

export type ApiContractProcedurePolicy = ApiContractMeta & {
  declaredServiceUnavailableCodes: ReadonlySet<string>;
};

interface ContractErrorItem {
  status?: number;
  message?: string;
  data?: AnySchema;
}

function isContractErrorItem(value: unknown): value is ContractErrorItem {
  return typeof value === 'object' && value !== null;
}

const procedurePolicyCache = new Map<string, ApiContractProcedurePolicy>();

/** Resolve and validate retry policy from the canonical contract once. */
export function apiContractProcedurePolicy(
  path: readonly string[],
): ApiContractProcedurePolicy {
  const name = path.join('.');
  const cached = procedurePolicyCache.get(name);
  if (cached) return cached;

  const procedure = getContractRouter(apiContract, path);
  if (!isContractProcedure(procedure)) {
    throw new Error(`Unknown API contract procedure: ${name}`);
  }
  const meta = apiContractMetaSchema.safeParse(procedure['~orpc'].meta);
  if (!meta.success) {
    throw new Error(
      `Invalid API contract policy for ${name}: ${meta.error.message}`,
    );
  }

  const declaredServiceUnavailableCodes = new Set<string>();
  for (const [code, definition] of Object.entries(
    procedure['~orpc'].errorMap,
  )) {
    if (isContractErrorItem(definition) && definition.status === 503) {
      declaredServiceUnavailableCodes.add(code);
    }
  }

  const policy = {
    ...meta.data,
    declaredServiceUnavailableCodes,
  } satisfies ApiContractProcedurePolicy;
  procedurePolicyCache.set(name, policy);
  return policy;
}

/** Collect one consistent definition for each error in the canonical contract. */
export function apiContractErrorDefinitions(): ApiContractErrorDefinition[] {
  const errors = new Map<string, ApiContractErrorDefinition>();

  function visit(value: unknown): void {
    if (isContractProcedure(value)) {
      for (const [code, rawItem] of Object.entries(value['~orpc'].errorMap)) {
        if (!isContractErrorItem(rawItem)) continue;
        const item = rawItem;
        if (
          typeof item.status !== 'number' ||
          !Number.isInteger(item.status) ||
          !item.message
        ) {
          throw new Error(
            `OpenAPI error ${code} must declare an integer status and message`,
          );
        }
        const definition: ApiContractErrorDefinition = {
          code,
          status: item.status,
          message: item.message,
          data: item.data,
        };
        const existing = errors.get(code);
        if (
          existing &&
          (existing.status !== definition.status ||
            existing.message !== definition.message ||
            existing.data !== definition.data)
        ) {
          throw new Error(`Conflicting OpenAPI definitions for error ${code}`);
        }
        errors.set(code, definition);
      }
      return;
    }

    if (typeof value !== 'object' || value === null) return;
    for (const child of Object.values(value)) visit(child);
  }

  visit(apiContract);
  return [...errors.values()].sort((left, right) =>
    left.code.localeCompare(right.code),
  );
}
