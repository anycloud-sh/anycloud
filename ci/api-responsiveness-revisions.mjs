import assert from 'node:assert/strict';

export async function resolveComparisonRevisions({ github, context }) {
  let baselineRef;
  let candidateRef;
  if (context.eventName === 'schedule') {
    assert.equal(
      context.ref,
      'refs/heads/main',
      'Daily comparisons require main',
    );
    const { data: release } = await github.rest.repos.getLatestRelease({
      owner: 'anycloud-sh',
      repo: 'releases',
    });
    assert(
      !release.draft && !release.prerelease,
      'Expected a published release',
    );
    assert.match(release.tag_name, /^v\d+\.\d+\.\d+$/, 'Invalid release tag');
    // The public release repository contains binaries, not the API source.
    baselineRef = 'refs/tags/' + release.tag_name;
    candidateRef = context.sha;
  } else {
    assert.equal(
      context.eventName,
      'workflow_dispatch',
      'Unsupported benchmark event',
    );
    baselineRef = context.payload.inputs?.base_ref?.trim() || 'main';
    candidateRef = context.payload.inputs?.candidate_ref?.trim() || context.sha;
  }

  const [baseline, candidate] = await Promise.all(
    [baselineRef, candidateRef].map(async (ref) => {
      const { data } = await github.rest.repos.getCommit({
        ...context.repo,
        ref,
      });
      assert.match(data.sha, /^[a-f0-9]{40}$/, 'Invalid resolved commit');
      return { ref, sha: data.sha };
    }),
  );
  return { event: context.eventName, baseline, candidate };
}
