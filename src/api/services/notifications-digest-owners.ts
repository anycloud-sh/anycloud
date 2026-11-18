/**
 * Digest owner folding: a local API reports all of its activity as one owner.
 */

import { isLocalOwnerId } from './api-authentication.js';
import type {
  DigestDeploymentJobSummary,
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
  const deployments = {
    presentAtEnd: 0,
    created: 0,
    deleted: 0,
    hasActivity: false,
  };
  for (const user of summary.users) {
    deployments.presentAtEnd += user.deployments.presentAtEnd;
    deployments.created += user.deployments.created;
    deployments.deleted += user.deployments.deleted;
    deployments.hasActivity ||= user.deployments.hasActivity;
  }
  return {
    summary: {
      ...summary,
      users: [
        {
          ...identity,
          jobs: summary.jobs,
          services: summary.services,
          vms: summary.vms,
          deployments,
          deploymentJobs: mergeDeploymentJobs(
            summary.users.flatMap((user) => user.deploymentJobs),
          ),
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

/** Owners' Jobs on one Deployment become one entry; its median is not shown. */
function mergeDeploymentJobs(
  targets: DigestDeploymentJobSummary[],
): DigestDeploymentJobSummary[] {
  const merged = new Map<string, DigestDeploymentJobSummary>();
  for (const target of targets) {
    const prior = merged.get(target.deploymentId);
    if (!prior) {
      merged.set(target.deploymentId, target);
      continue;
    }
    const sum = { ...prior, p50RuntimeMs: null };
    for (const key of [
      'initialSubmissions',
      'resubmissions',
      'total',
      'completed',
      'failed',
      'errored',
      'terminated',
      'invalid',
      'preempted',
    ] as const) {
      sum[key] += target[key];
    }
    merged.set(target.deploymentId, sum);
  }
  return [...merged.values()];
}
