const DAY = 24 * 60 * 60 * 1000;
const MIB = 1024 * 1024;

/** @typedef {{id: number, name: string, size_in_bytes: number, expired: boolean, created_at: string, workflow_run?: {id: number}}} Artifact */
/** @typedef {{id: number, status: string, conclusion: string | null, updated_at: string, run_attempt: number, path?: string, referenced_workflows?: {path: string}[]}} Run */
/** @typedef {{key: string, kind: string, artifacts: Artifact[], run: Run, bytes: number, createdAt: number, reason?: string}} Group */

export function completedStorageTarget(now = Date.now()) {
  return (now < Date.parse('2026-10-01T00:00:00Z') ? 20 : 250) * MIB;
}

export function artifactKind(name) {
  if (
    /^(managed-gpu-cleanup-authority|managed-gpu-recovery|managed-kubernetes-qualification|managed-kubernetes-records|e2e-(?:cluster|claim-burst)-local-records|e2e-cluster-cloud|lambda-boot-failover|conversation-capture|recovery-evidence|vm-comparison-evidence|service-comparison-evidence|job-comparison-evidence|implementation-evidence)-/.test(
      name,
    )
  )
    return 'recovery';
  if (/^mutation-(harness|sample)-/.test(name)) return 'mutation';
  if (
    name.startsWith('api-responsiveness-') ||
    name === 'billing-responsiveness' ||
    name === 'billing-settlement-qualification'
  )
    return 'performance';
  if (name === 'managed-gpu-candidate') return 'candidate';
  if (
    ['cli-binary-artifacts', 'release-python-sdk-distributions'].includes(
      name,
    ) ||
    /^digest-(amd64|arm64)$/.test(name)
  )
    return 'release';
  if (
    ['generated-python-sdk', 'python-sdk-distributions'].includes(name) ||
    /^deps-digests-/.test(name)
  )
    return 'transfer';
  if (name === 'docs-build' || name.endsWith('.dockerbuild')) return 'unused';
  if (
    /^(test-logs-|nuke-logs-|gpu-qualification-|managed-kubernetes-logs-|azure-spot-restart-race-|azure-ghcr-probe-|lambda-boot-probe-)/.test(
      name,
    )
  )
    return 'diagnostic';
  return 'unknown';
}

/** @param {Run} run */
export function isQualification(run) {
  return [
    run.path,
    ...(run.referenced_workflows ?? []).map((entry) => entry.path),
  ]
    .filter(Boolean)
    .some((path) => path.includes('/managed-kubernetes-qualification.yml'));
}

/**
 * A run is eligible only when the REST API has positively identified it as
 * completed. Missing metadata, recovery records, mutation reports and unknown
 * names are retained.
 * Release artifacts form one eviction unit so a retained retry stays complete.
 * @param {{artifacts: Artifact[], runs: Map<number, Run>, qualificationActive: boolean, now?: number, targetBytes?: number}} input
 */
export function planArtifactCleanup({
  artifacts,
  runs,
  qualificationActive,
  now = Date.now(),
  targetBytes = completedStorageTarget(now),
}) {
  /** @type {Map<string, Group>} */
  const groups = new Map();
  const live = artifacts.filter((artifact) => !artifact.expired);
  const unknown = live.filter(
    (artifact) => artifactKind(artifact.name) === 'unknown',
  );
  let activeBytes = 0;
  let protectedBytes = 0;
  for (const artifact of live) {
    const kind = artifactKind(artifact.name);
    const run = runs.get(artifact.workflow_run?.id);
    if (run && run.status !== 'completed') {
      activeBytes += artifact.size_in_bytes;
      continue;
    }
    if (
      !run ||
      !Number.isFinite(Date.parse(run.updated_at)) ||
      !Number.isFinite(Date.parse(artifact.created_at)) ||
      ['recovery', 'mutation', 'unknown'].includes(kind) ||
      // Measurements keep their full retention window.
      (kind === 'performance' &&
        now - Date.parse(artifact.created_at) < 7 * DAY) ||
      (kind === 'release' && qualificationActive)
    ) {
      protectedBytes += artifact.size_in_bytes;
      continue;
    }
    const key =
      kind +
      ':' +
      (kind === 'diagnostic' || kind === 'unused' ? artifact.id : run.id);
    const group = groups.get(key) ?? {
      key,
      kind,
      artifacts: [],
      run,
      bytes: 0,
      createdAt: Date.parse(artifact.created_at),
    };
    group.artifacts.push(artifact);
    group.bytes += artifact.size_in_bytes;
    group.createdAt = Math.min(
      group.createdAt,
      Date.parse(artifact.created_at),
    );
    groups.set(key, group);
  }
  const ordered = [...groups.values()].sort(
    (a, b) =>
      Date.parse(b.run.updated_at) - Date.parse(a.run.updated_at) ||
      b.run.id - a.run.id,
  );
  const newestCandidate = ordered.find(
    (group) => group.kind === 'candidate' && group.run.conclusion !== 'success',
  );
  const newestRelease = ordered.find((group) => group.kind === 'release');
  for (const group of ordered) {
    const completedAge = now - Date.parse(group.run.updated_at);
    const artifactAge = now - group.createdAt;
    if (group.kind === 'unused') group.reason = 'unused upload';
    if (group.kind === 'candidate') {
      if (group.run.conclusion === 'success')
        group.reason = 'qualification completed successfully';
      else if (completedAge >= DAY)
        group.reason = '24-hour candidate retry window ended';
      else if (group !== newestCandidate)
        group.reason = 'superseded failed candidate';
    }
    if (group.kind === 'release') {
      if (completedAge >= DAY)
        group.reason = '24-hour release retry window ended';
      else if (group !== newestRelease) group.reason = 'superseded release';
    }
    if (group.kind === 'transfer') {
      if (group.run.conclusion === 'success')
        group.reason = 'all workflow consumers succeeded';
      else if (artifactAge >= DAY)
        group.reason = '1-day transfer retention ended';
    }
    if (group.kind === 'diagnostic' && artifactAge >= 3 * DAY)
      group.reason = '3-day diagnostic retention ended';
    if (group.kind === 'performance' && artifactAge >= 7 * DAY)
      group.reason = '7-day performance evidence retention ended';
  }
  const beforeBytes = live.reduce(
    (sum, artifact) => sum + artifact.size_in_bytes,
    0,
  );
  let remainingBytes = beforeBytes - activeBytes;
  // Expired policy entries go first; large bundles reclaim the most space if
  // a bounded pass stops early. Pressure evictions then follow oldest first.
  const selected = ordered
    .filter((group) => group.reason)
    .sort((a, b) => b.bytes - a.bytes);
  remainingBytes -= selected.reduce((sum, group) => sum + group.bytes, 0);
  for (const group of [...ordered].reverse()) {
    if (remainingBytes <= targetBytes) break;
    if (group.reason) continue;
    group.reason = 'completed-run storage exceeds target';
    remainingBytes -= group.bytes;
    selected.push(group);
  }
  return {
    beforeBytes,
    activeBytes,
    protectedBytes,
    targetBytes,
    plannedAfterBytes: remainingBytes + activeBytes,
    unknown,
    groups: selected,
  };
}
