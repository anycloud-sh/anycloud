import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Exact owner paths measured at landing, each with 10 lines of
// headroom.
// Lower a ceiling when its file shrinks. Growth past one means splitting the
// file; a reviewed raise records its rationale in the comment beside it.
// A ceiling above 800 also names an open split issue (`split: '#N'`) or the
// responsibility its parts share (`whole: '...'`).
export const ownerSizeCeilings = {
  'src/api/services/monitor.ts': 590, // 573 + 10 (684 before an earlier split); 577 after the outcome wiring; +7: delivers live Secret files on the Job, Service and VM polls and wakes a poll on save
  'src/api/services/notifications-digest.ts': 373, // 363 + 10 (897 before an earlier change)
  'src/api/services/notifications-digest-format.ts': 564, // 554 + 10
  'src/api/services/cost-calculation/monitor.ts': 138, // 128 + 10: batches one billing query per credential and tag
  'src/cli/commands/credentials/new.ts': 192, // 182 + 10: adds the --role flags and examples (235 before its split)
  'src/cli/use-cases/save-credential.ts': 120, // 110 + 10
  'src/cli/commands/quota.ts': 176, // 166 + 10 (661 before its split)
  'src/cli/use-cases/quota-status.ts': 313, // 303 + 10
  'src/cli/renderers/quota-status.ts': 247, // 237 + 10
  'src/cli/prompts/quota-types.ts': 30, // 20 + 10
  'src/cli/commands/status.ts': 207, // 197 + 10 (995 before its split)
  'src/cli/use-cases/workload-status.ts': 175, // 165 + 10
  'src/cli/renderers/workload-status.ts': 735, // 725 + 10
  'src/cli/commands/list.ts': 425, // 415 + 10 (1126 before its split)
  'src/cli/use-cases/workload-list.ts': 365, // 355 + 10
  'src/cli/renderers/workload-list.ts': 506, // 496 + 10
  'src/cli/prompts/workload-list.ts': 43, // 33 + 10
  'src/api/services/repositories/workload-lifecycle.ts': 778, // 760 on main + 11; the requeue gives a targeted Job's `--timeout` window again. 752 + 10 (1252 before an earlier change); +7: an in-place restart of a cloud-stopped VM binds its live row
  'src/api/services/repositories/workload-outcomes.ts': 531, // +11: the seed self-delete's pending-cleanup listing (RFC 0049 C26). 503 + 10 (523 before an earlier change); +7: RFC 0049 C15's end reason on every terminal outcome
  'src/api/services/repositories/workload-creation.ts': 213, // 203 + 10
  'src/api/services/repositories/provisioning-attempts.ts': 427, // 411 + 10; +6 past it: records a failed launch's classification on its row
  'src/api/services/repositories/workload-events.ts': 395, // 374 + 10; +11: counts a VM Job's Recovering transitions for --max-retries
  'src/api/services/repositories/credential-secrets.ts': 540, // 477 + 10; +5 for the compare-and-swap that keeps concurrent `credentials edit` calls from losing a change; +10: refuses to move a credential's name to a second save of its material; +38: Secret revision reads and its Running referencing Workloads
  'src/api/services/repositories/workload-queries.ts': {
    ceiling: 1585, // +2: polls a Running Service that names Secrets. +2: a multi-type flag that lets a region-pinned VM Job fail over between its VM types. +2: the VM Job regions column. +4: the gp3 IOPS and throughput columns. +2: the launched VM type on each VM. +2: the host-docker column. +4: the no-checkpoint and nested-virtualization columns. +15: the seed self-delete's live VM-host Workload check (RFC 0049 C26). +2: RFC 0049 C3's max retries column. 1523 + 10 (1603 before an earlier change read launch history from vms alone); +4 past it: a region-health guard on unclassified launch failures; +13: RFC 0049 C15's end reason columns and the newest VM's preempt flag
    whole:
      'one Workload read model: every non-spend read of Workload, container spec, VM and provisioning state',
  },
  'src/api/services/repositories/workload-spend.ts': 699, // 686 + 13; SLOT's slot-time rows and session burn share the windowed VM spend SQL beside them
  'src/api/services/repositories/deployment-executions.ts': {
    ceiling: 873, // +3: RFC 0049 C15's end reason on expired and unassigned Jobs. 857 + 13; the replica image pull on the replica's first claim event, and the check that keeps later claims from reading kubelet's events. 839 + 18; the discovery offers, which keep concurrent waiters off one Job (ST1a 829 + 10; 897 before an earlier change moved its reports to workload-attempts.ts)
    whole:
      "the claim queue: discovery, the claim with a fence that guards it, and the execution reads a replica makes; SLOT's spend gate is in claim-spend-gate.ts",
  },
  'src/api/services/repositories/node-pool-services.ts': 95, // 68 + 10; 85 + 10 after the publishedAt, the entry hand-off's cue that every record moved
  'src/api/services/workload-workflows/retry-recovery.ts': {
    ceiling: 809, // 787 + 10 (842 before an earlier change); +3: RFC 0049 C15's reclaimed last attempt; +9: on-demand Jobs share the stopped-VM restart, worded as a cloud stop
    whole:
      'retry and recovery: a stopped or unreachable host, the Recovering claim, in-place restart or replacement, and the retry budgets',
  },
  'src/api/services/host-runtime/vm-release-observer.ts': 172, // 162 + 10
  'src/api/services/workload-workflows/cleanup.ts': 198, // 188 + 10 (198 after an earlier split)
  'src/api/services/host-runtime/termination.ts': 376, // 366 + 10 (353 before the attempt labels)
  'src/api/services/workload-workflows/completion.ts': 568, // 556 + 10 (561 after an earlier split); +2 past it: the outcome port, split from the lifecycle port
  'src/api/services/workload-workflows/completion-reconcile.ts': 184, // 158 + 10 (189 before an earlier change); +16: restarts an unreachable on-demand Job's cloud-stopped VM in place, and says why it uses the loose stopped read
  'src/api/services/workload-workflows/vm-host-startup.ts': 686, // 639 + 10; +7 past it: records launch failures on the attempt row before the Retrying transition (671 before an earlier change moved launch classification to launch-targets.ts); +7 more: checks the GPU after an in-place restart and claims the bad VM's removal before teardown; +2: passes a CPU VM Job's host preparation (job-host.ts) to provisioning; +1: sets a VM Job's network-peer refusal; +6: marks a recorded launch failover for its immediate retry; +6: writes Secret files for adopted containers; +8: initializes and pulls a Job host through containerd's parallel unpacks
  'src/api/services/host-runtime/host-startup.ts': 349, // 316 + 10 (319 after an earlier split); +21: resolves Secrets with revisions and writes adopted containers' files; +2: passes a Job host to initializeVM
  // 624 + 10: an earlier transfer-credential Docker fallback and full-disk errors;
  // + 12: a per-pull Docker config, removed after every pull.
  'src/api/services/host-runtime/image-delivery.ts': 653, // 646 + 6: passes both pulls through pull-timing.ts and records its fields; +1: qualifies the transfer's image reference for ctr
  'src/api/services/workload-workflows/persistent-vm-repair.ts': 236, // 224 + 10; +2: forgets a failed restart's backoff once the host answers
  'src/api/services/host-runtime/vm-container-repair.ts': 192, // 182 + 10
  'src/api/services/workload-workflows/workload-pipeline.ts': 509, // 494 + 10; 498 after the outcome port; +9: polls a Workload that names Secrets once its pipeline settles, so a Secret saved during its start reaches it
  'src/api/services/workload-workflows/provisioning-scheduler.ts': 398, // 388 + 10 (390 after an earlier split); 394 after the outcome port
  'src/api/services/workload-workflows/targeted-job.ts': 113, // 97 + 10 (120 before an earlier change moved the retry budget to its writer) + 6 (deletes a spot pool Job's managed checkpoint bucket before its cleanup completes)
  'src/api/services/credential-auth-failure.ts': 86, // 76 + 10 (85 after an earlier split)
  'src/api/services/workload-admission-checks.ts': 146, // 136 + 10
};

export function checkProductionOwnerSizes(
  readFile,
  ceilings = ownerSizeCeilings,
) {
  const failures = [];
  for (const [file, entry] of Object.entries(ceilings)) {
    const { ceiling, split, whole } =
      typeof entry === 'number' ? { ceiling: entry } : entry;
    if (!Number.isInteger(ceiling)) {
      failures.push(`${file}: its entry needs a numeric ceiling.`);
      continue;
    }
    if (
      ceiling > 800 &&
      !/^#\d+$/.test(split) &&
      !(typeof whole === 'string' && whole.trim())
    ) {
      failures.push(
        `${file}: its ${ceiling}-line ceiling is above 800, so it needs ` +
          "split: '#N' (an open split issue) or whole: '<the shared " +
          "responsibility>' in scripts/check-production-owner-sizes.mjs.",
      );
    }
    const source = readFile(file);
    const lines =
      source.split(/\r?\n/).length - (source.endsWith('\n') ? 1 : 0);
    if (lines > ceiling) {
      failures.push(
        `${file}: ${lines} lines exceeds the ${ceiling}-line owner ceiling. ` +
          'Split the file along its responsibilities, or, if the growth is ' +
          'justified, raise its ceiling in this PR with the rationale in the ' +
          'comment beside it in scripts/check-production-owner-sizes.mjs.',
      );
    }
  }
  return failures;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const failures = checkProductionOwnerSizes((file) =>
    readFileSync(path.join(root, file), 'utf8'),
  );
  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    process.exitCode = 1;
  }
}
