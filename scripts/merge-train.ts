// Merges a green merge train, as the release-tracker template's 🚂 Merge train
// section describes: squash-merges each PR in boarding order at its reviewed
// head, stops at the first failure, then compares main's tree with the train's
// and prints the arrival line for the tracker. Run through tsx
// (`yarn train:merge --train origin/train/<release>-N <pr>=<head> ...`).

import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const run = (command: string, ...args: string[]) =>
  execFileSync(command, args, { encoding: 'utf8' }).trim();

function main() {
  const { values, positionals } = parseArgs({
    options: { train: { type: 'string' } },
    allowPositionals: true,
  });
  const boarding = positionals.map((pair) => {
    const match = /^(\d+)=([0-9a-f]{40})$/.exec(pair);
    if (!match) throw new Error(`Expected <pr>=<full head SHA>, got ${pair}`);
    return { pr: match[1], head: match[2] };
  });
  if (!values.train || boarding.length === 0)
    throw new Error(
      'Usage: yarn train:merge --train <train ref> <pr>=<head> [<pr>=<head> ...]',
    );

  run('git', 'fetch', '--quiet', 'origin');
  const trainTree = run('git', 'rev-parse', `${values.train}^{tree}`);
  const merged: string[] = [];
  const stop = (pr: string, reason: string, cause?: unknown) =>
    new Error(
      `Stopped at #${pr}: ${reason}. Merged so far: ${merged.join(', ') || 'none'}`,
      { cause },
    );
  for (const { pr, head } of boarding) {
    const view = (fields: string) =>
      JSON.parse(run('gh', 'pr', 'view', pr, '--json', fields));
    // A stacked PR still based on a lower PR's branch would merge into that
    // branch instead of main.
    const { baseRefName } = view('baseRefName');
    if (baseRefName !== 'main')
      throw stop(pr, `its base is ${baseRefName}, not main`);
    try {
      run('gh', 'pr', 'merge', pr, '--squash', '--match-head-commit', head);
    } catch (error) {
      throw stop(pr, `merge at ${head} failed`, error);
    }
    const { state, mergeCommit } = view('state,mergeCommit');
    if (state !== 'MERGED') throw stop(pr, `state is ${state} after merging`);
    merged.push(`#${pr} → ${mergeCommit.oid.slice(0, 9)}`);
  }

  run('git', 'fetch', '--quiet', 'origin', 'main');
  const mainTree = run('git', 'rev-parse', 'origin/main^{tree}');
  const treeLine =
    mainTree === trainTree
      ? `main's tree equals the train tree ${trainTree.slice(0, 9)}`
      : `main's tree ${mainTree.slice(0, 9)} differs from the train tree ${trainTree.slice(0, 9)}`;
  console.log(`🚂 Train arrived: ${merged.join(', ')}; ${treeLine}.`);
  if (mainTree !== trainTree) {
    console.log(
      `\nDifference (train → main); check that only commits outside the train explain it:\n${run('git', 'diff', '--stat', trainTree, mainTree)}`,
    );
    process.exitCode = 1;
  }
}

main();
