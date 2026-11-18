/**
 * Digest owner folding: a local API reports all of its activity as one owner.
 */

import { isLocalOwnerId } from './api-authentication.js';
import type {
  DigestSpend,
  DigestSummary,
} from './notifications-digest-format.js';

/**
 * A local API has one owner, but rows it held before upgrading to local
 * ownership keep the GitHub owner they were created with. Once a local owner
 * appears, report the whole API as that owner.
 */
export function foldLocalApiOwners(
  summary: DigestSummary,
  spend: DigestSpend,
): { summary: DigestSummary; spend: DigestSpend } {
  const owner = [...summary.users, ...spend.users].find(
    (user) => user.ownerUserId !== null && isLocalOwnerId(user.ownerUserId),
  );
  if (!owner) return { summary, spend };
  const identity = { userId: owner.userId, ownerUserId: owner.ownerUserId };
  return {
    summary: {
      ...summary,
      users: [
        {
          ...identity,
          jobs: summary.jobs,
          services: summary.services,
          vms: summary.vms,
        },
      ],
    },
    spend: {
      ...spend,
      users: [
        {
          ...identity,
          jobs: spend.jobs,
          services: spend.services,
          vms: spend.vms,
        },
      ],
    },
  };
}
