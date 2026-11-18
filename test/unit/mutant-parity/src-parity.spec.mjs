import { describe, expect, it } from 'vitest';

import {
  changedRanges,
  chunkRanges,
  compareReports,
  coveringSpecs,
  floorLines,
  formatComparison,
  formatScores,
  formatSurvivors,
  scoreFiles,
  UNRUNNABLE_SPECS,
} from '../../mutant-parity/src-parity.mjs';

// As resolved from "symbols": "*", so `fresh` may be new at head.
const plan = {
  moves: [
    {
      from: 'src/old.ts',
      to: 'src/new.ts',
      symbols: ['first', 'pick', 'fresh'],
      expanded: true,
    },
  ],
};

// A mutant replacing the nth occurrence of `text` in `source`.
function mutant(source, text, replacement, status, nth = 0, extra = {}) {
  let index = -1;
  for (let i = 0; i <= nth; i++) index = source.indexOf(text, index + 1);
  const position = (offset) => {
    const lines = source.slice(0, offset).split('\n');
    return { line: lines.length, column: lines.at(-1).length + 1 };
  };
  return {
    mutatorName: 'EqualityOperator',
    replacement,
    status,
    location: {
      start: position(index),
      end: position(index + text.length),
    },
    ...extra,
  };
}

function report(path, source, mutants) {
  return {
    files: {
      [path]: {
        source,
        mutants: mutants.map((args) => mutant(source, ...args)),
      },
    },
    testFiles: { 'pick.spec.ts': { tests: [{ id: '7', name: 'pick kills' }] } },
  };
}

// `first` moves and gains `export`; `pick` also changes its parameter type,
// which shifts every later offset, and Prettier drops a trailing comma; `fresh`
// is new at head.
const baseSource = [
  'const keep = 1 > 0;',
  'function first() {\n  return 2 > 1;\n}',
  'function pick(a: Store) {\n  return { a, b: a > 1, };\n}',
].join('\n');
const headSource = [
  'export function first() {\n  return 2 > 1;\n}',
  'export function pick(a: LifecycleStore) {\n    return { a, b: a > 1 };\n}',
  'function fresh() {\n  return 3 > 1;\n}',
].join('\n');

function compare(pickBefore, pickAfter, rerun) {
  // Stryker's timer sets neither killedBy nor a reason on a Timeout.
  const killedBy =
    pickBefore === 'Timeout'
      ? {}
      : { killedBy: ['7'], statusReason: 'expected 1\n  at x' };
  return compareReports(
    plan,
    report('src/old.ts', baseSource, [
      ['1 > 0', '1 >= 0', 'Survived'],
      ['2 > 1', '2 >= 1', 'Survived'],
      ['a > 1', 'a >= 1', pickBefore, 0, killedBy],
      ['{ a, b: a > 1, }', '{}', 'Killed'],
    ]),
    report('src/new.ts', headSource, [
      ['2 > 1', '2 >= 1', 'NoCoverage'],
      ['a > 1', 'a >= 1', pickAfter],
      ['{ a, b: a > 1 }', '{}', 'Killed'],
      ['3 > 1', '3 >= 1', 'Killed'],
    ]),
    rerun,
  );
}

// A rerun of `pick`'s candidate loss on one host.
const rerunPick = (pickBefore, pickAfter = 'Survived', extra = {}) => ({
  base: report('src/old.ts', baseSource, [
    ['a > 1', 'a >= 1', pickBefore, 0, extra],
  ]),
  head: report('src/new.ts', headSource, [['a > 1', 'a >= 1', pickAfter]]),
});

describe('src mutant parity', () => {
  it('matches by offset, then by text after an earlier edit, and accepts kept kills', () => {
    const result = compare('Killed', 'Killed');
    expect(result.matchedBy).toEqual({ offset: 1, text: 2 });
    expect(result.lost).toEqual([]);
    // Undetected on both sides is a pre-existing gap, not a loss.
    expect(result.bothSurvived).toEqual({ first: 1 });
    expect(result.unmatched).toMatchObject([
      { side: 'head', symbol: 'fresh', reason: 'new at head' },
    ]);
    // New code is named but does not make the matching weak.
    expect(formatComparison(result)).toContain(
      '**Not matched: base 0 of 3 (0.0%); head 1 of 4 (25.0%).**\nNew at head, not counted as weak matching: fresh.\n',
    );
  });

  it('rejects a mapping that does not match the source', () => {
    const [base, head] = [
      report('src/old.ts', baseSource, []),
      report('src/new.ts', headSource, []),
    ];
    const named = { moves: [{ ...plan.moves[0], expanded: false }] };
    expect(() => compareReports(named, base, head)).toThrow(
      'fresh not found in src/old.ts',
    );
    const twice = { moves: [...plan.moves, { ...plan.moves[0], to: 'x.ts' }] };
    expect(() => compareReports(twice, base, head)).toThrow(
      'base: first is mapped twice in src/old.ts',
    );
  });

  it('rejects a run whose covered survivors ran no tests', () => {
    const silent = { coveredBy: ['7'], testsCompleted: 0 };
    expect(() =>
      compare('Killed', 'Survived', rerunPick('Survived', 'Survived', silent)),
    ).toThrow('src/old.ts:6 ran no tests.');
  });

  it('rejects a mutant killed or timed out before that loses coverage after', () => {
    const result = compare('Killed', 'NoCoverage');
    expect(result.lost).toHaveLength(1);
    expect(formatComparison(result)).toContain(
      'Not yet rerun on one host: run the `rerun` step before triage.\n- src/new.ts:5 EqualityOperator → `a >= 1` (Killed → NoCoverage; base src/old.ts:6, killed by pick kills: expected 1)',
    );
    expect(formatComparison(compare('Timeout', 'Survived'))).toContain(
      '(Timeout → Survived; base src/old.ts:6)',
    );
  });

  it('keeps a loss only if the single-host rerun reproduces it', () => {
    const flake = compare('Killed', 'Survived', rerunPick('Survived'));
    expect(flake.lost).toEqual([]);
    expect(formatComparison(flake)).toContain(
      'Killed before, surviving after: 0\n\nDid not reproduce on one host (not losses): 1\n- src/new.ts:5 EqualityOperator → `a >= 1` (Killed → Survived; base src/old.ts:6, killed by pick kills: expected 1; rerun Survived → Survived)',
    );
    const lost = (rerun) => compare('Killed', 'Survived', rerun).lost.length;
    expect(lost(rerunPick('Killed', 'Killed'))).toBe(0);
    expect(lost(rerunPick('Killed'))).toBe(1);
    // A candidate the rerun lacks stays a loss.
    expect(lost({ ...rerunPick('Killed'), head: report('x.ts', '', []) })).toBe(
      1,
    );
  });

  it('leaves an ambiguous text group unmatched, lists detected base mutants first, and flags weak matching', () => {
    const source =
      'function pick(a: LifecycleStore) {\n  return a > 1 || a > 1;\n}';
    const result = compareReports(
      plan,
      report('src/old.ts', baseSource, [['a > 1', 'a >= 1', 'Killed']]),
      report('src/new.ts', source, [
        ['a > 1', 'a >= 1', 'Survived'],
        ['a > 1', 'a >= 1', 'Survived', 1],
      ]),
    );
    expect(result.lost).toEqual([]);
    expect(result.unmatched.map((m) => m.side)).toEqual([
      'base',
      'head',
      'head',
    ]);
    expect(result.unmatched[0].reason).toBe(
      'changed code: 1 base and 2 head left with this mutator, replacement and text',
    );
    const text = formatComparison(result);
    expect(text).toContain('Over 5% of a side is unmatched: matching is weak');
    expect(text).toContain(
      '**Detected at base but unmatched: 1. Check each by hand for a loss.**',
    );
  });

  it('keys a method moved to a renamed class to the method, not the class', () => {
    const renamed = {
      moves: [
        {
          from: 'src/old.ts',
          to: 'src/new.ts',
          symbols: [
            ['WorkloadStore', 'LifecycleStore'],
            ['WorkloadStore.claim', 'LifecycleStore.claim'],
          ],
        },
      ],
    };
    const result = compareReports(
      renamed,
      report(
        'src/old.ts',
        'class WorkloadStore {\n  claim(a) {\n    return a > 1;\n  }\n}',
        [['a > 1', 'a >= 1', 'Killed']],
      ),
      report(
        'src/new.ts',
        'export class LifecycleStore {\n  constructor() {}\n  claim(a) {\n    return a > 1;\n  }\n}',
        [['a > 1', 'a >= 1', 'Survived']],
      ),
    );
    expect(result.matchedBy).toEqual({ offset: 1, text: 0 });
    expect(result.unmatched).toEqual([]);
    expect(result.lost).toMatchObject([
      { after: { symbol: 'LifecycleStore.claim', at: 'src/new.ts:4' } },
    ]);
  });

  it('pairs a bare boolean literal by its line, not across lines', () => {
    const moved = {
      moves: [{ from: 'src/old.ts', to: 'src/new.ts', symbols: ['flags'] }],
    };
    const bool = { mutatorName: 'BooleanLiteral' };
    const result = compareReports(
      moved,
      report(
        'src/old.ts',
        'function flags(a) {\n  if (a) mode(true);\n  return a.tty === true;\n}',
        [
          ['true', 'false', 'Survived', 0, bool],
          ['true', 'false', 'Killed', 1, bool],
        ],
      ),
      // The earlier edit shifts `mode(true)`, and the `tty` line changed.
      report(
        'src/new.ts',
        'function flags(a: Opts) {\n  const tty = a.tty === true;\n  if (a) mode(true);\n  return tty;\n}',
        [
          ['true', 'false', 'Survived', 0, bool],
          ['true', 'false', 'Survived', 1, bool],
        ],
      ),
    );
    expect(result.matchedBy).toEqual({ offset: 0, text: 1 });
    expect(result.lost).toEqual([]);
    expect(result.unmatched).toMatchObject([
      { side: 'base', at: 'src/old.ts:3', status: 'Killed' },
      { side: 'head', at: 'src/new.ts:2' },
    ]);
  });

  it('pairs a split symbol with its parts, by offset only within a kept name', () => {
    const symbols = [['old', ['src/view.ts:ne2', 'old']]];
    const split = {
      moves: [{ from: 'src/old.ts', to: 'src/new.ts', symbols }],
    };
    // `ne2`'s `r.b` sits at the offset of the base `r.a`.
    const [old, ne2] = [
      report('src/new.ts', 'function old(r) {\n  if (r.a) x();\n}', [
        ['r.a', 'true', 'Survived'],
      ]),
      report('src/view.ts', 'function ne2(r) {\n  if (r.b) y();\n}', [
        ['r.b', 'true', 'Killed'],
      ]),
    ];
    const result = compareReports(
      split,
      report(
        'src/old.ts',
        'function old(r) {\n  if (r.a) x();\n  if (r.b) y();\n  if (r.c) z();\n}',
        [
          ['r.a', 'true', 'Killed'],
          ['r.b', 'true', 'Killed'],
          ['r.c', 'true', 'Killed'],
        ],
      ),
      { files: { ...ne2.files, ...old.files } },
    );
    expect(result.matchedBy).toEqual({ offset: 1, text: 1 });
    expect(result.lost).toMatchObject([
      { after: { symbol: 'ne2 + old', at: 'src/new.ts:2' } },
    ]);
    // `r.c` was dropped from every part, so it can't pair.
    expect(result.unmatched).toMatchObject([
      { side: 'base', at: 'src/old.ts:4', reason: /^in a split: 1 base and 0/ },
    ]);
  });

  it('lists each node and mutator once, with literal mutants last', () => {
    const source = "function fresh() {\n  return log('x') || 3 > 1;\n}";
    const [string, condition] = [
      { mutatorName: 'StringLiteral' },
      { mutatorName: 'ConditionalExpression' },
    ];
    const result = compareReports(
      plan,
      report('src/old.ts', baseSource, []),
      report('src/new.ts', source, [
        ["'x'", '""', 'Survived', 0, string],
        ['3 > 1', 'true', 'Survived', 0, condition],
        ['3 > 1', 'false', 'Survived', 0, condition],
      ]),
    );
    expect(formatComparison(result)).toContain(
      'Not matched: 3\n- head src/new.ts:2 ConditionalExpression → `true` [Survived]: new at head (+1 on this node: → `false` [Survived])\n- head src/new.ts:2 StringLiteral → `""` [Survived]: new at head',
    );
  });

  it('flags a side whose specs never reach the moved symbols', () => {
    const result = compareReports(
      plan,
      report('src/old.ts', baseSource, [
        ['2 > 1', '2 >= 1', 'NoCoverage'],
        ['a > 1', 'a >= 1', 'NoCoverage'],
      ]),
      report('src/new.ts', headSource, [
        ['2 > 1', '2 >= 1', 'Killed'],
        ['a > 1', 'a >= 1', 'Survived'],
      ]),
    );
    const text = formatComparison(result);
    expect(text).toContain(
      "**The base side has no coverage of the moved symbols: fix the plan's spec list.**",
    );
    expect(text).not.toContain('The head side');
  });
});

describe('src mutation score', () => {
  it('finds the unit specs that reach a file through imports or mocks', () => {
    const sources = {
      'src/a.ts': "export const a = 1;\nconst note = 'not/a/path';",
      'src/b.ts': "import { a } from './a.js';",
      'src/c.ts': "import { x } from './unrelated.js';",
      'test/helpers/store.ts': "import { b } from '../../src/b';",
      'test/unit/direct.spec.ts': "vi.mock('../../src/a.js');",
      'test/unit/nested/helper.spec.mjs':
        "import { store } from '../../helpers/store.ts';",
      'test/unit/other.spec.ts': "import { c } from '../../src/c';",
      'test/integration/flow.spec.ts': "import '../../src/a';",
    };
    expect(
      coveringSpecs(
        [...Object.keys(sources), 'README.md'],
        (path) => sources[path],
        'src/a.ts',
      ),
    ).toEqual(['test/unit/direct.spec.ts', 'test/unit/nested/helper.spec.mjs']);
  });

  it('splits a file at top-level declarations and class members only', () => {
    const source = [
      'const one = 1;', // 1
      'class Store {', // 2
      '  first() {', // 3
      '    return 1;', // 4
      '  }', // 5
      '  second() {', // 6
      '    return 2;', // 7
      '  }', // 8
      '}', // 9
      'function last() {', // 10
      '  return 3;', // 11
      '}', // 12
    ].join('\n');
    expect(chunkRanges('src/x.ts', source, 3)).toEqual([
      [1, 5],
      [6, 9],
      [10, 12],
    ]);
    expect(
      chunkRanges('src/x.ts', 'function only() {\n  return 1;\n}', 2),
    ).toEqual([[1, 3]]);
  });

  it('scores each file from its chunks and lists every file below its floor', () => {
    const chunk = (file, chunk, statuses) => ({
      run: { file, chunk },
      report: {
        files: {
          [file]: {
            source: '1 > 0',
            mutants: statuses.map((status) =>
              mutant('1 > 0', '1 > 0', '1 >= 0', status),
            ),
          },
        },
      },
    });
    const chunks = [
      chunk('src/b.ts', '1/1', [
        'Killed',
        'Survived',
        'NoCoverage',
        'Timeout',
        'CompileError',
      ]),
      chunk('src/a.ts', '1/2', ['Killed', 'Killed']),
      chunk('src/a.ts', '2/2', ['Killed', 'Survived']),
      chunk('src/c.ts', '1/2', ['Killed']),
      chunk('src/d.ts', '1/1', ['CompileError']),
    ];
    // src/e.ts was planned, but its only chunk uploaded no report.
    const scores = scoreFiles(chunks, [
      ...chunks.map(({ run }) => run),
      { file: 'src/e.ts', chunk: '1/1' },
    ]);
    expect(scores.map(({ file, score }) => [file, score])).toEqual([
      ['src/a.ts', 75],
      ['src/b.ts', 50],
      ['src/c.ts', undefined],
      ['src/d.ts', undefined],
      ['src/e.ts', undefined],
    ]);
    const text = formatScores(scores, {
      'src/a.ts': 75,
      'src/b.ts': 53,
      'src/c.ts': 85,
      'src/d.ts': null,
      'src/e.ts': 60,
    });
    expect(text).toContain('| `src/a.ts` | 3 | 0 | 1 | 0 | 75.0% | 75 |');
    expect(text).toContain(
      '| `src/c.ts` | 1 | 0 | 0 | 0 | incomplete (1 of 2 chunks) | 85 |',
    );
    expect(text).toContain('| `src/d.ts` | 0 | 0 | 0 | 0 | no mutants | — |');
    expect(text).toContain(
      '| `src/e.ts` | 0 | 0 | 0 | 0 | not scored: all chunks failed | 60 |',
    );
    expect(text).toContain(
      'Below floor: 1\n- `src/b.ts`: 50.0%, below its floor of 53. Add a test, or lower the floor with a rationale on the PR.',
    );
    expect(text).toContain(
      'on the PR.\n\nNot scored: 3\n- `src/c.ts`: incomplete (1 of 2 chunks)\n- `src/d.ts`: no mutants\n- `src/e.ts`: not scored: all chunks failed',
    );
  });

  it('leaves out only the specs that cannot pass in Stryker', () => {
    expect(
      [
        'test/unit/eslint-plugin/local-plugin.spec.mjs',
        'test/unit/ci/vast-attempt-audit.spec.ts',
        'test/unit/scripts/ci-backend-workflow.spec.ts',
        'test/unit/services/notifications-config.spec.ts',
        'test/unit/services/notifications-digest.spec.ts',
        'test/unit/services/slack-notifier.spec.ts',
      ].filter((spec) => !UNRUNNABLE_SPECS.test(spec)),
    ).toEqual([
      'test/unit/services/notifications-digest.spec.ts',
      'test/unit/services/slack-notifier.spec.ts',
    ]);
  });
});

describe('changed-line survivors', () => {
  it('reads the changed src TypeScript lines from a zero-context diff', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -3 +3 @@ export const x = 1;',
      '@@ -10,2 +9,0 @@', // a deletion leaves nothing to mutate
      '@@ -20,0 +21,3 @@',
      '--- a/src/gone.ts',
      '+++ /dev/null',
      '@@ -1,4 +0,0 @@',
      '+++ b/docs/x.md',
      '@@ -1 +1 @@',
    ].join('\n');
    expect([...changedRanges(diff)]).toEqual([
      [
        'src/a.ts',
        [
          [3, 3],
          [21, 23],
        ],
      ],
    ]);
  });

  it('lists undetected mutants once per node, literals last, capped, with the changed owners and their floors', () => {
    const source =
      "export function f(a) {\n  log.info('x');\n  return a > 1 && a < 9;\n}";
    const status = (text, replacement, mutatorName, nth = 0, st = 'Survived') =>
      mutant(source, text, replacement, st, nth, { mutatorName });
    const report = {
      files: {
        'src/a.ts': {
          source,
          mutants: [
            status("'x'", '""', 'StringLiteral'),
            status('a > 1', 'true', 'ConditionalExpression'),
            status('a > 1', 'false', 'ConditionalExpression', 0, 'NoCoverage'),
            status('a < 9', 'a <= 9', 'EqualityOperator'),
            status(
              'a > 1 && a < 9',
              'a > 1 || a < 9',
              'LogicalOperator',
              0,
              'Killed',
            ),
          ],
        },
      },
    };
    const ranges = new Map([['src/a.ts', [[2, 3]]]]);
    const floors = { 'src/a.ts': 70 };
    const text = formatSurvivors(report, ranges, floors, 'abc', 2);
    expect(text).toContain(
      '**Mutants on changed lines: 5** (3 Survived, 1 NoCoverage, 1 Killed).',
    );
    expect(text).toContain(
      '- src/a.ts:3 `a > 1` → `true` [Survived] (+1 on this node: → `false` [NoCoverage])\n- src/a.ts:3 `a < 9` → `a <= 9` [Survived]\n- and 1 more in the run artifact',
    );
    expect(text).toContain(
      '- `src/a.ts`: floor 70%, 4 undetected on changed lines\nCheck their whole scores: `gh workflow run mutant-parity.yml -f mode=score -f source_sha=abc -f targets="src/a.ts"`',
    );
    const killed = { ...report.files['src/a.ts'] };
    killed.mutants = killed.mutants.slice(-1);
    expect(
      formatSurvivors({ files: { 'src/a.ts': killed } }, ranges, {}, 'abc'),
    ).toBe(
      '**Mutants on changed lines: 1** (1 Killed).\n\nEvery mutant on the changed lines is detected.',
    );
  });

  it('says the floor owners were not run when the change is over the limit', () => {
    expect(
      floorLines(['src/a.ts', 'src/b.ts'], { 'src/a.ts': 85 }, 'abc'),
    ).toContain('- `src/a.ts`: floor 85%, not run (over the limit)');
  });
});
