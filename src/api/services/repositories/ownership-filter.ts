import type { User } from '../entities.js';

export type OwnershipIdentity = Pick<User, 'id' | 'username'>;

/**
 * Which workload rows a query is allowed to reach: every row of this API.
 * A hosted API's callers already cleared the same access policy, and a local
 * API has one owner, the holder of its per-install token. A revoked member's
 * workloads, and rows earlier releases keyed by GitHub account, stay
 * reachable by whoever is left.
 */
export type OwnershipScope = { kind: 'api' };

export interface OwnershipBranch {
  kind: 'all';
  sql: string;
  params: string[];
}

export interface OwnershipPredicate {
  sql: string;
  params: string[];
}

/**
 * Scope still has to produce a WHERE fragment: every caller splices these into
 * a larger predicate, and an always-true term keeps those call sites from
 * needing a second SQL shape.
 */
const MATCHES_EVERY_ROW = '1 = 1';

export function ownershipBranches(
  _scope: OwnershipScope,
  _tableAlias?: string,
): OwnershipBranch[] {
  return [{ kind: 'all', sql: MATCHES_EVERY_ROW, params: [] }];
}

/** Point lookups and mutations are already bounded by a workload/operation id. */
export function ownershipPredicate(
  scope: OwnershipScope,
  tableAlias?: string,
): OwnershipPredicate {
  const branches = ownershipBranches(scope, tableAlias);
  // Always parenthesize the whole disjunction: callers splice this into a
  // larger WHERE with AND, which binds tighter than OR.
  return {
    sql: `(${branches.map((branch) => `(${branch.sql})`).join(' OR ')})`,
    params: branches.flatMap((branch) => branch.params),
  };
}
