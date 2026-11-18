// Before/after mutant parity for src refactor moves. Mutates the moved
// symbols in their old home at `base` and their new home at `head`, then lists
// mutants the base specs detected but the head specs no longer detect. The
// `score` step mutates whole production owners and checks their floors, and the
// `diff` step reports the survivors on a change's lines.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { basename, dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Instrumenter } from '@stryker-mutator/instrumenter';
import ts from 'typescript';

const DETECTED = new Set(['Killed', 'Timeout']);
const UNDETECTED = new Set(['Survived', 'NoCoverage']);
const atRisk = (m) => m.side === 'base' && DETECTED.has(m.status);
// Literal mutants, most often equivalent in the m1–m4 reports, are listed last.
const late = ({ mutatorName }) =>
  /^(StringLiteral|ArrayDeclaration|ObjectLiteral|Regex)$/u.test(mutatorName);
const rank = (a, b) => late(a) - late(b);
const nodeKey = (m) => [m.range, m.mutatorName, m.replacement].join('\0');
// Specs that can't pass in Stryker's dry run, so every run leaves them out.
// Whole-tree architecture and policy specs, such as the module graph and size
// ceilings, read the real tree, which the sandbox replaces with instrumented
// copies. notifications-config.spec.ts points HOME at a temporary directory,
// which `os.homedir()` ignores in Stryker's worker threads, and
// e2e-api-routing.spec.ts starts the built API, which the sandbox lacks.
export const UNRUNNABLE_SPECS =
  /^test\/unit\/((ci|eslint-plugin|scripts)\/|services\/notifications-config\.spec\.ts$|e2e-api-routing\.spec\.ts$)/u;
// A PR's check fits about this many mutants in its 30 minutes.
const DIFF_MUTANT_LIMIT = 150;
// Timeouts count as detected, so both sides run with identical limits.
const RUN_OPTIONS = {
  concurrency: 4,
  timeoutMS: 5000,
  timeoutFactor: 1.5,
};

// Top-level runtime declarations (functions, classes, variables) and the
// members of top-level classes as `Class.member`, by name.
function topLevelSymbols(fileName, text) {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  const symbols = new Map();
  const add = (name, node, origin) => {
    const previous = symbols.get(name); // overloads and accessor pairs
    const start = previous?.start ?? node.getStart(source);
    symbols.set(name, {
      start,
      end: node.end,
      // Offsets count from the name, so adding `export` keeps them stable.
      origin: previous?.origin ?? origin,
      startLine: source.getLineAndCharacterOfPosition(start).line + 1,
      endLine: source.getLineAndCharacterOfPosition(node.end).line + 1,
    });
  };
  for (const statement of source.statements) {
    const names = ts.isVariableStatement(statement)
      ? statement.declarationList.declarations.map((d) => d.name)
      : (ts.isFunctionDeclaration(statement) ||
            ts.isClassDeclaration(statement)) &&
          statement.name
        ? [statement.name]
        : [];
    for (const node of names) {
      add(node.getText(), statement, node.getStart(source));
    }
    if (!ts.isClassDeclaration(statement) || !statement.name) continue;
    for (const member of statement.members) {
      const name = ts.isConstructorDeclaration(member)
        ? 'constructor'
        : member.name?.getText();
      if (!name) continue;
      add(
        `${statement.name.text}.${name}`,
        member,
        (member.name ?? member).getStart(source),
      );
    }
  }
  return symbols;
}

// A symbol is a name on both sides, a [base, head] pair when the move renames
// it, or [base, [head, ...]] when it splits, with `path:symbol` for a part in
// another file. Mutants are keyed by the head names. A named symbol must exist
// on both sides; one that "*" expanded may be new at head.
function movedFiles(plan, side) {
  const files = new Map();
  const add = (path, entry) => {
    const entries = files.get(path) ?? [];
    if (entries.some(({ name }) => name === entry.name)) {
      throw new Error(`${side}: ${entry.name} is mapped twice in ${path}`);
    }
    files.set(path, [...entries, entry]);
  };
  for (const move of plan.moves) {
    for (const symbol of move.symbols) {
      const [base, head] = Array.isArray(symbol) ? symbol : [symbol, symbol];
      const parts = [head]
        .flat()
        .map((part) => [move.to, ...part.split(':')].slice(-2));
      const id = parts.map(([, name]) => name).join(' + ');
      const split = Array.isArray(head);
      const entry = (name) => ({ name, id, split, named: !move.expanded });
      if (side === 'base') add(move.from, entry(base));
      for (const [path, name] of side === 'head' ? parts : []) {
        add(path, entry(name));
      }
    }
  }
  return files;
}

const reportKey = (report, path) =>
  Object.keys(report.files).find(
    (file) => file === path || file.endsWith(`/${path}`),
  );

function checkedFile(report, key, path) {
  const file = report.files[key];
  // stryker-js#6210: a runner that runs no tests reports survivors.
  const silent = file.mutants.find(
    (m) => m.status === 'Survived' && m.coveredBy?.length && !m.testsCompleted,
  );
  if (silent)
    throw new Error(`${path}:${silent.location.start.line} ran no tests.`);
  return file;
}

function indexSide(report, files) {
  const tests = new Map(
    Object.values(report.testFiles ?? {})
      .flatMap((file) => file.tests)
      .map((test) => [test.id, test.name]),
  );
  const mutants = [];
  const present = new Set();
  for (const [path, entries] of files) {
    const key = reportKey(report, path);
    if (!key) continue;
    const { source, mutants: fileMutants } = checkedFile(report, key, path);
    const symbols = topLevelSymbols(path, source);
    for (const { name, id, named } of entries) {
      if (symbols.has(name)) present.add(id);
      else if (named) throw new Error(`${name} not found in ${path}`);
    }
    const lineStarts = [0];
    for (let i = 0; i < source.length; i++) {
      if (source[i] === '\n') lineStarts.push(i + 1);
    }
    const offset = ({ line, column }) => lineStarts[line - 1] + column - 1;
    const located = fileMutants.map((mutant) => ({
      mutant,
      start: offset(mutant.location.start),
      end: offset(mutant.location.end),
    }));
    located.sort((a, b) => a.start - b.start || a.end - b.end);
    for (const { mutant, start, end } of located) {
      // The innermost symbol, so `Class.method` wins over `Class`.
      let symbol;
      let range;
      for (const entry of entries) {
        const candidate = symbols.get(entry.name);
        if (
          candidate &&
          candidate.start <= start &&
          end <= candidate.end &&
          (!range || candidate.end - candidate.start < range.end - range.start)
        ) {
          [symbol, range] = [entry, candidate];
        }
      }
      if (!symbol) continue;
      const offsets = [start - range.origin, end - range.origin];
      const kind = [symbol.id, mutant.mutatorName, mutant.replacement];
      const { start: from, end: to } = mutant.location;
      // A bare `true` or `false` is paired by its whole line, so it can't pair
      // with a literal on an unrelated line.
      const text = /^(true|false)$/u.test(source.slice(start, end))
        ? source.slice(lineStarts[from.line - 1], lineStarts[from.line])
        : source.slice(start, end);
      mutants.push({
        // A split's part pairs by offset only if it keeps the base name.
        offsetKey: [symbol.split && symbol.name, ...kind, ...offsets].join(
          '\0',
        ),
        split: symbol.split,
        // Ignores whitespace and trailing commas, so rewrapping keeps the text.
        textKey: [
          ...kind,
          text.replace(/\s+/gu, '').replace(/,([)\]}])/gu, '$1'),
        ].join('\0'),
        symbol: symbol.id,
        at: `${path}:${from.line}`,
        // Stryker's --mutate range for this node, with 0-based columns.
        range: `${key}:${from.line}:${from.column - 1}-${to.line}:${to.column - 1}`,
        mutatorName: mutant.mutatorName,
        replacement: mutant.replacement,
        status: mutant.status,
        killedBy: mutant.killedBy?.map((id) => tests.get(id) ?? id).join(', '),
        statusReason: mutant.statusReason?.split('\n')[0],
      });
    }
  }
  return { mutants, present };
}

function tally(mutants) {
  const counts = {};
  for (const { status } of mutants) counts[status] = (counts[status] ?? 0) + 1;
  return counts;
}

// Pairs mutants of the same symbol, mutator and replacement: first by offset
// from the symbol's name, then the rest by mutated text in source order. An
// edit earlier in the symbol, such as a renamed parameter type, shifts every
// later offset but keeps the text. Text pairs only form when both sides have
// the same number of leftovers with that text, so an added or removed copy
// leaves the group unmatched instead of shifting the pairs.
function pair(baseMutants, headMutants) {
  const pairs = [];
  const heads = Map.groupBy(headMutants, (m) => m.offsetKey);
  const rest = [];
  for (const before of baseMutants) {
    const after = heads.get(before.offsetKey)?.shift();
    if (after) pairs.push({ before, after, by: 'offset' });
    else rest.push(before);
  }
  const befores = Map.groupBy(rest, (m) => m.textKey);
  const afters = Map.groupBy([...heads.values()].flat(), (m) => m.textKey);
  const unmatched = [];
  for (const key of new Set([...befores.keys(), ...afters.keys()])) {
    const [base, head] = [befores.get(key) ?? [], afters.get(key) ?? []];
    if (base.length === head.length) {
      base.forEach((before, i) =>
        pairs.push({ before, after: head[i], by: 'text' }),
      );
      continue;
    }
    const reason = `${[...base, ...head][0].split ? 'in a split' : 'changed code'}: ${base.length} base and ${head.length} head left with this mutator, replacement and text`;
    unmatched.push(
      ...base.map((m) => ({ side: 'base', ...m, reason })),
      ...head.map((m) => ({ side: 'head', ...m, reason })),
    );
  }
  return { pairs, unmatched };
}

// With a single-host rerun of the candidate losses, a candidate is dropped when
// the rerun has it undetected at base or detected at head.
export function compareReports(plan, baseReport, headReport, rerun) {
  const index = (report, side) => indexSide(report, movedFiles(plan, side));
  const base = index(baseReport, 'base');
  const head = index(headReport, 'head');
  const statuses = (side) =>
    new Map(
      index(rerun[side], side).mutants.map((m) => [nodeKey(m), m.status]),
    );
  const again = rerun && { base: statuses('base'), head: statuses('head') };
  const { pairs, unmatched } = pair(base.mutants, head.mutants);
  for (const m of unmatched) {
    if (!base.present.has(m.symbol)) m.reason = 'new at head';
  }
  // A detected base mutant without a pair may be a loss the matching missed,
  // typically a block enclosing an edited line, so it is listed first.
  unmatched.sort((a, b) => atRisk(b) - atRisk(a) || rank(a, b));
  const lost = [];
  const unconfirmed = [];
  const bothSurvived = {};
  const matchedBy = { offset: 0, text: 0 };
  for (const { before, after, by } of pairs) {
    matchedBy[by]++;
    if (DETECTED.has(before.status) && UNDETECTED.has(after.status)) {
      const rerunStatus = again && {
        base: again.base.get(nodeKey(before)),
        head: again.head.get(nodeKey(after)),
      };
      const reproduced = !(
        UNDETECTED.has(rerunStatus?.base) || DETECTED.has(rerunStatus?.head)
      );
      (reproduced ? lost : unconfirmed).push({ before, after, rerunStatus });
    } else if (UNDETECTED.has(before.status) && UNDETECTED.has(after.status)) {
      bothSurvived[before.symbol] = (bothSurvived[before.symbol] ?? 0) + 1;
    }
  }
  return {
    counts: { base: tally(base.mutants), head: tally(head.mutants) },
    matchedBy,
    lost: lost.sort((a, b) => rank(a.after, b.after)),
    unconfirmed: unconfirmed.sort((a, b) => rank(a.after, b.after)),
    unmatched,
    bothSurvived,
  };
}

const quote = (text) =>
  `\`${text.replaceAll('`', "'").replace(/\s+/gu, ' ')}\``;

// One line per side, node and mutator, such as a condition forced `true` and
// `false`, in compareReports' order. A loss is listed by its head mutant.
function oncePerNode(list, line) {
  const groups = Map.groupBy(list, (entry) => {
    const { side, range, mutatorName } = entry.after ?? entry;
    return [side, range, mutatorName].join('\0');
  });
  return [...groups.values()].map(([entry, ...rest]) => {
    const more = rest.map((e) => e.after ?? e);
    return `${line(entry)}${more.length ? ` (+${more.length} on this node: ${more.map((m) => `→ ${quote(m.replacement)} [${m.status}]`).join(', ')})` : ''}`;
  });
}

export function formatComparison(
  { counts, matchedBy, lost, unconfirmed, unmatched, bothSurvived },
  runs = {},
) {
  const statuses = [
    ...new Set([...Object.keys(counts.base), ...Object.keys(counts.head)]),
  ].sort();
  const item = (m) => `${m.at} ${m.mutatorName} → ${quote(m.replacement)}`;
  const total = (side) =>
    Object.values(counts[side]).reduce((a, b) => a + b, 0);
  // Mutants of symbols new at head are new code, not a matching failure, so
  // they don't count toward weak matching.
  const added = unmatched.filter((m) => m.reason === 'new at head');
  const share = (side) => {
    const own = unmatched.filter((m) => m.side === side).length;
    const percent = (count) => (100 * count) / Math.max(total(side), 1);
    return {
      text: `${side} ${own} of ${total(side)} (${percent(own).toFixed(1)}%)`,
      weak: percent(side === 'head' ? own - added.length : own) > 5,
    };
  };
  const [base, head] = [share('base'), share('head')];
  const risky = unmatched.filter(atRisk).length;
  // A side whose specs never reach the moved code reports no loss trivially.
  const uncovered = ['base', 'head'].filter(
    (side) =>
      !counts[side].Killed &&
      !counts[side].Timeout &&
      counts[side].NoCoverage > (counts[side].Survived ?? 0),
  );
  // A Timeout has no killing test, and a timer's Timeout no reason either.
  const loss = ({ before, after, rerunStatus: again }) => {
    const why = [
      before.killedBy && `killed by ${before.killedBy}`,
      before.statusReason,
    ].filter(Boolean);
    const rerun = again
      ? `; rerun ${again.base ?? 'missing'} → ${again.head ?? 'missing'}`
      : '';
    return `- ${item(after)} (${before.status} → ${after.status}; base ${before.at}${why.length ? `, ${why.join(': ')}` : ''}${rerun})`;
  };
  return [
    `**Not matched: ${base.text}; ${head.text}.**` +
      (base.weak || head.weak
        ? ' Over 5% of a side is unmatched: matching is weak, so read the losses below with caution.'
        : ''),
    ...uncovered.map(
      (side) =>
        `**The ${side} side has no coverage of the moved symbols: fix the plan's spec list.**`,
    ),
    ...(risky
      ? [
          `**Detected at base but unmatched: ${risky}. Check each by hand for a loss.**`,
        ]
      : []),
    ...(added.length
      ? [
          `New at head, not counted as weak matching: ${[...new Set(added.map((m) => m.symbol))].join(', ')}.`,
        ]
      : []),
    `Matched ${matchedBy.offset} by offset and ${matchedBy.text} by text.`,
    '',
    ...Object.entries(runs).map(
      ([side, run]) =>
        `- ${side} ${run.commit}: ${run.minutes} min, ${Object.entries(
          run.options,
        )
          .map(([key, value]) => `${key} ${value}`)
          .join(
            ', ',
          )}, load ${run.loadStart} → ${run.loadEnd}, host ${run.host ?? 'not recorded'}`,
    ),
    '',
    '| Status | Base | Head |',
    '| --- | ---: | ---: |',
    ...statuses.map(
      (s) => `| ${s} | ${counts.base[s] ?? 0} | ${counts.head[s] ?? 0} |`,
    ),
    '',
    `Killed before, surviving after: ${lost.length}`,
    ...(lost.some((l) => !l.rerunStatus)
      ? ['Not yet rerun on one host: run the `rerun` step before triage.']
      : []),
    ...oncePerNode(lost, loss),
    ...(unconfirmed.length
      ? [
          '',
          `Did not reproduce on one host (not losses): ${unconfirmed.length}`,
          ...oncePerNode(unconfirmed, loss),
        ]
      : []),
    '',
    `Survived on both sides (pre-existing gaps, not losses): ${Object.values(
      bothSurvived,
    ).reduce((a, b) => a + b, 0)}`,
    ...Object.entries(bothSurvived)
      .sort(([, a], [, b]) => b - a)
      .map(([symbol, count]) => `- ${symbol}: ${count}`),
    '',
    `Not matched: ${unmatched.length}`,
    ...oncePerNode(
      unmatched,
      (m) => `- ${m.side} ${item(m)} [${m.status}]: ${m.reason}`,
    ),
  ].join('\n');
}

// Unit specs that import or mock `target`, directly or through other src or
// test modules. `paths` lists the tree's files.
export function coveringSpecs(paths, read, target) {
  const module = (path) => path.replace(/\.[cm]?[jt]s$/u, '');
  const importers = Map.groupBy(
    paths
      .filter((path) => /^(src|test)\/.*\.[cm]?[jt]s$/u.test(path))
      .flatMap((path) =>
        [...read(path).matchAll(/['"`](\.\.?\/[^'"`\n]+)['"`]/gu)].map(
          ([, to]) => [module(normalize(join(dirname(path), to))), path],
        ),
      ),
    ([to]) => to,
  );
  const spec = (path) => /^test\/unit\/.*\.spec\.[cm]?[jt]s$/u.test(path);
  const reached = new Set([target]);
  for (const path of reached) {
    if (spec(path)) continue;
    for (const [, from] of importers.get(module(path)) ?? []) reached.add(from);
  }
  return [...reached].filter(spec).sort();
}

// `count` line ranges of about equal length, cut only where a top-level
// declaration or class member starts, so no mutant spans two. A file with too
// few declarations gets fewer ranges.
export function chunkRanges(fileName, text, count) {
  const lines = text.split('\n').length;
  const starts = [...topLevelSymbols(fileName, text).values()].map(
    (symbol) => symbol.startLine,
  );
  const cuts = [1];
  for (let k = 1; k < count; k++) {
    const target = 1 + (k * lines) / count;
    const next = starts.filter((line) => line > cuts.at(-1));
    if (!next.length) break;
    cuts.push(
      next.reduce((a, b) =>
        Math.abs(b - target) < Math.abs(a - target) ? b : a,
      ),
    );
  }
  return cuts.map((start, i) => [start, (cuts[i + 1] ?? lines + 1) - 1]);
}

// One score per `expected` file from the `score` step's chunk reports, as
// Stryker counts it: detected over detected and undetected. A file missing a
// chunk, or with no mutants, has none.
export function scoreFiles(chunks, expected = chunks.map(({ run }) => run)) {
  const reports = Map.groupBy(chunks, ({ run }) => run.file);
  return [...Map.groupBy(expected, ({ file }) => file)]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, [{ chunk }]]) => {
      const parts = reports.get(file) ?? [];
      const mutants = parts.flatMap(({ report }) => {
        const key = reportKey(report, file);
        return key ? checkedFile(report, key, file).mutants : [];
      });
      const counts = tally(mutants);
      const [detected, undetected] = [DETECTED, UNDETECTED].map((set) =>
        mutants.filter((m) => set.has(m.status)),
      );
      const total = Number(chunk.split('/')[1]);
      const done = new Set(parts.map(({ run }) => run.chunk)).size;
      const scored = detected.length + undetected.length;
      const unscored =
        (!done && 'not scored: all chunks failed') ||
        (done < total && `incomplete (${done} of ${total} chunks)`) ||
        (!scored && 'no mutants');
      const score = (100 * detected.length) / scored;
      return { file, counts, unscored, ...(!unscored && { score }) };
    });
}

export function formatScores(scores, floors) {
  const statuses = ['Killed', 'Timeout', 'Survived', 'NoCoverage'];
  const percent = (score) => `${score.toFixed(1)}%`;
  const below = scores.filter(({ file, score }) => score < floors[file]);
  const unscored = scores.filter(({ unscored }) => unscored);
  return [
    `| File | ${statuses.join(' | ')} | Score | Floor |`,
    `| --- |${' ---: |'.repeat(statuses.length + 2)}`,
    ...scores.map(
      ({ file, counts, score, unscored }) =>
        `| \`${file}\` | ${statuses.map((s) => counts[s] ?? 0).join(' | ')} | ${unscored || percent(score)} | ${floors[file] ?? '—'} |`,
    ),
    '',
    `Below floor: ${below.length}`,
    ...below.map(
      ({ file, score }) =>
        `- \`${file}\`: ${percent(score)}, below its floor of ${floors[file]}. Add a test, or lower the floor with a rationale on the PR.`,
    ),
    '',
    `Not scored: ${unscored.length}`,
    ...unscored.map(({ file, unscored }) => `- \`${file}\`: ${unscored}`),
  ].join('\n');
}

// Each `src/` TypeScript file's changed line ranges in a `git diff -U0`.
export function changedRanges(diff) {
  const ranges = new Map();
  let file;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ '))
      file = /^\+\+\+ b\/(src\/.+\.ts)$/u.exec(line)?.[1];
    const hunk = file && /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (!hunk || hunk[2] === '0') continue;
    const start = Number(hunk[1]);
    const end = start + Number(hunk[2] ?? 1) - 1;
    ranges.set(file, [...(ranges.get(file) ?? []), [start, end]]);
  }
  return ranges;
}

const clip = (text) =>
  quote(text.length > 60 ? `${text.slice(0, 57)}...` : text);

// The changed files that have a floor, and how to check their whole score.
// Without `survivors`, the mutants weren't run.
export function floorLines(files, floors, head, survivors) {
  const owners = files.filter((file) => file in floors);
  if (!owners.length) return [];
  return [
    '',
    '**Owner files with floors**',
    ...owners.map((file) => {
      const count = survivors?.filter((m) => m.file === file).length;
      return `- \`${file}\`: ${floors[file] === null ? 'no floor yet (under 60%)' : `floor ${floors[file]}%`}, ${survivors ? `${count} undetected on changed lines` : 'not run (over the limit)'}`;
    }),
    `Check their whole scores: \`gh workflow run mutant-parity.yml -f mode=score -f source_sha=${head} -f targets="${owners.join(' ')}"\``,
  ];
}

// Undetected mutants on the changed lines, once per node and mutator, with
// literal mutants last, as in the parity report, and at most `limit` lines.
export function formatSurvivors(report, ranges, floors, head, limit = 15) {
  const mutants = [...ranges.keys()].flatMap((file) => {
    const key = reportKey(report, file);
    if (!key) return [];
    const { source, mutants: fileMutants } = checkedFile(report, key, file);
    const lines = source.split('\n');
    return fileMutants.map((m) => {
      const { start, end } = m.location;
      const text = lines.slice(start.line - 1, end.line).join('\n');
      return {
        ...m,
        file,
        at: `${file}:${start.line}`,
        range: `${file}:${start.line}:${start.column}`,
        original: text.slice(
          start.column - 1,
          text.length - lines[end.line - 1].length + end.column - 1,
        ),
      };
    });
  });
  const counts = tally(mutants);
  const undetected = mutants
    .filter((m) => UNDETECTED.has(m.status))
    .sort(
      (a, b) => rank(a, b) || a.at.localeCompare(b.at, 'en', { numeric: true }),
    );
  const listed = oncePerNode(
    undetected,
    (m) =>
      `- ${m.at} ${clip(m.original)} → ${clip(m.replacement)} [${m.status}]`,
  );
  return [
    `**Mutants on changed lines: ${mutants.length}** (${Object.entries(counts)
      .map(([status, count]) => `${count} ${status}`)
      .join(', ')}).`,
    ...(listed.length
      ? [
          '',
          '**Survived or not covered on changed lines** (no unit test fails when the line changes; literal mutants last):',
          ...listed.slice(0, limit),
          ...(listed.length > limit
            ? [`- and ${listed.length - limit} more in the run artifact`]
            : []),
        ]
      : ['', 'Every mutant on the changed lines is detected.']),
    ...floorLines([...ranges.keys()], floors, head, undetected),
  ].join('\n');
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

// "*" selects every symbol of the head file.
function resolvePlan(root, plan) {
  return {
    ...plan,
    moves: plan.moves.map((move) => ({
      ...move,
      expanded: move.symbols === '*',
      symbols:
        move.symbols === '*'
          ? [
              ...topLevelSymbols(
                move.to,
                git(root, ['show', `${plan.head}:${move.to}`]),
              ).keys(),
            ]
          : move.symbols,
    })),
  };
}

// Extracts `commit` into the ignored report directory and runs Stryker there
// on the ranges and specs `select(tree)` returns, saving `<name>.json` and
// `<name>.run.json` (with `record`) in `outDir`.
function mutate(root, commit, outDir, name, select, record = {}) {
  // A plain archive in the ignored report directory, not a git worktree.
  const tree = join(outDir, `${name}-tree`);
  rmSync(tree, { recursive: true, force: true });
  mkdirSync(tree);
  execFileSync('tar', ['-x', '-C', tree], {
    input: execFileSync('git', ['archive', commit], {
      cwd: root,
      maxBuffer: 2 ** 31,
    }),
  });
  try {
    symlinkSync(join(root, 'node_modules'), join(tree, 'node_modules'));
    cpSync(
      join(root, 'vitest.src-mutation.config.mjs'),
      join(tree, 'vitest.src-mutation.config.mjs'),
    );
    const { ranges, specs, dryRunSpecs = specs } = select(tree);
    const kept = specs.filter((spec) => !UNRUNNABLE_SPECS.test(spec));
    if (kept.length < specs.length) {
      console.log(
        `Left out specs that can't pass in Stryker: ${specs.filter((spec) => !kept.includes(spec)).join(', ')}`,
      );
    }
    // A minute of dry run per six specs of the larger side, and at least five.
    const options = {
      ...RUN_OPTIONS,
      dryRunTimeoutMinutes: Math.max(5, Math.ceil(dryRunSpecs.length / 6)),
    };
    const load = () => loadavg()[0].toFixed(2);
    const loadStart = load();
    const started = Date.now();
    const child = spawnSync(
      process.execPath,
      [
        join(root, 'node_modules/@stryker-mutator/core/bin/stryker.js'),
        'run',
        join(root, 'stryker.src.config.mjs'),
        '--mutate',
        ranges.join(','),
        ...Object.entries(options).flatMap(([key, value]) => [
          `--${key}`,
          String(value),
        ]),
      ],
      {
        cwd: tree,
        stdio: 'inherit',
        env: { ...process.env, MUTATION_SPECS: kept.join(',') },
      },
    );
    if (child.status !== 0) throw new Error(`${name} Stryker run failed.`);
    cpSync(
      join(tree, 'reports/mutation/src/mutation.json'),
      join(outDir, `${name}.json`),
    );
    const run = {
      ...record,
      commit,
      minutes: ((Date.now() - started) / 60_000).toFixed(1),
      options,
      loadStart,
      loadEnd: load(),
      host: `${cpus().length}× ${cpus()[0]?.model}`,
    };
    writeFileSync(join(outDir, `${name}.run.json`), JSON.stringify(run));
    console.log(`${name} (${commit}) took ${run.minutes} min`);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
}

// Mutates the plan's symbols, or only the `rerun` mutants' nodes.
function runSide(root, plan, side, outDir, rerun) {
  const name = rerun ? `${side}.rerun` : side;
  mutate(root, plan[side], outDir, name, (tree) => {
    const ranges = new Set(rerun?.map((m) => m.range));
    for (const [path, entries] of rerun ? [] : movedFiles(plan, side)) {
      const symbols = topLevelSymbols(
        path,
        readFileSync(join(tree, path), 'utf8'),
      );
      for (const { name, named } of entries) {
        const range = symbols.get(name);
        if (range) ranges.add(`${path}:${range.startLine}-${range.endLine}`);
        else if (named)
          throw new Error(`${side}: ${name} not found in ${path}`);
      }
    }
    const { base, head } = plan.specs;
    return {
      ranges: [...ranges],
      specs: plan.specs[side],
      dryRunSpecs: base.length > head.length ? base : head,
    };
  });
}

// Mutates chunk `k` of `n` of `file` at HEAD against its covering specs.
function runScore(root, file, chunk, outDir) {
  const [k, n] = chunk.split('/').map(Number);
  const commit = git(root, ['rev-parse', 'HEAD']).trim();
  const name = `${file.replaceAll('/', '_')}.${k}`;
  mutate(
    root,
    commit,
    outDir,
    name,
    (tree) => {
      const read = (path) => readFileSync(join(tree, path), 'utf8');
      const range = chunkRanges(file, read(file), n)[k - 1];
      if (!range) throw new Error(`${file} has fewer than ${n} chunks.`);
      const paths = git(root, ['ls-tree', '-r', '--name-only', commit]);
      return {
        ranges: [`${file}:${range.join('-')}`],
        specs: coveringSpecs(paths.split('\n'), read, file),
      };
    },
    { file, chunk },
  );
}

// Reports the survivors on the lines HEAD changes since its merge base with
// `base`, mutating them only if they fit a PR check.
async function runDiff(root, base, outDir) {
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  const since = git(root, ['merge-base', base, head]).trim();
  const ranges = changedRanges(
    git(root, [
      'diff',
      '-U0',
      '--no-color',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      since,
      head,
      '--',
      'src',
    ]),
  );
  const floors = JSON.parse(
    readFileSync(join(root, 'test/mutant-parity/floors.json'), 'utf8'),
  );
  const files = [...ranges.keys()];
  // Stryker's instrumenter counts the mutants without running a test.
  const silent = new Proxy({}, { get: () => () => false });
  const { mutants } = await new Instrumenter(silent).instrument(
    files.map((name) => ({
      name,
      content: git(root, ['show', `${head}:${name}`]),
      mutate: ranges.get(name).map(([start, end]) => ({
        start: { line: start - 1, column: 0 },
        end: { line: end - 1, column: Number.MAX_SAFE_INTEGER },
      })),
    })),
    { plugins: null, excludedMutations: [], ignorers: [] },
  );
  if (!mutants.length) return 'No mutants on the changed `src/` lines.';
  if (mutants.length > DIFF_MUTANT_LIMIT) {
    return [
      `**${mutants.length} mutants on the changed lines, over this check's limit of ${DIFF_MUTANT_LIMIT}, so they weren't run.** Dispatch the Mutant Parity workflow instead (\`test/mutant-parity/README.md\`): a parity plan for a refactor, or \`mode=score\` for the changed owners.`,
      ...floorLines(files, floors, head),
    ].join('\n');
  }
  // Files whose changed lines have no mutants, such as comments, add no specs.
  const mutated = files.filter((file) =>
    mutants.some((m) => m.fileName === file),
  );
  mutate(root, head, outDir, 'head', (tree) => {
    const read = (path) => readFileSync(join(tree, path), 'utf8');
    const paths = git(root, ['ls-tree', '-r', '--name-only', head]).split('\n');
    return {
      ranges: mutated.flatMap((file) =>
        ranges.get(file).map(([start, end]) => `${file}:${start}-${end}`),
      ),
      specs: [
        ...new Set(mutated.flatMap((file) => coveringSpecs(paths, read, file))),
      ],
    };
  });
  const report = JSON.parse(readFileSync(join(outDir, 'head.json'), 'utf8'));
  return formatSurvivors(report, ranges, floors, head);
}

const invokedPath = process.argv[1];
if (
  invokedPath &&
  import.meta.url === pathToFileURL(resolve(invokedPath)).href
) {
  const [planPath, step = 'all', chunk = '1/1'] = process.argv.slice(2);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const scoreDir = join(root, 'reports/mutation/src-parity/score');
  if (planPath === 'score') {
    mkdirSync(scoreDir, { recursive: true });
    if (process.argv.length > 3) runScore(root, step, chunk, scoreDir);
    else {
      const read = (name) =>
        JSON.parse(readFileSync(join(scoreDir, name), 'utf8'));
      const chunks = readdirSync(scoreDir)
        .filter((name) => name.endsWith('.run.json'))
        .map((name) => ({
          run: read(name),
          report: read(name.replace(/\.run\.json$/u, '.json')),
        }));
      const floors = JSON.parse(
        readFileSync(join(root, 'test/mutant-parity/floors.json'), 'utf8'),
      );
      // The workflow passes every planned chunk, so a failed one still shows.
      const { CHUNKS } = process.env;
      const expected = CHUNKS ? JSON.parse(CHUNKS) : undefined;
      const text = formatScores(scoreFiles(chunks, expected), floors);
      writeFileSync(join(scoreDir, 'report.md'), `${text}\n`);
      console.log(text);
    }
    process.exit();
  }
  if (planPath === 'diff') {
    const outDir = join(root, 'reports/mutation/src-parity/diff');
    mkdirSync(outDir, { recursive: true });
    const text = await runDiff(root, step, outDir);
    writeFileSync(join(outDir, 'report.md'), `${text}\n`);
    console.log(text);
    process.exit();
  }
  if (!planPath || !/^(all|base|head|rerun|compare)$/u.test(step)) {
    throw new Error(
      'Usage: src-parity.mjs <plan> [base|head|rerun|compare], score [<file> [<k>/<n>]], or diff <base>',
    );
  }
  const plan = resolvePlan(root, JSON.parse(readFileSync(planPath, 'utf8')));
  const outDir = join(
    root,
    'reports/mutation/src-parity',
    basename(planPath, '.json'),
  );
  mkdirSync(outDir, { recursive: true });
  const read = (name) =>
    JSON.parse(readFileSync(join(outDir, `${name}.json`), 'utf8'));
  const report = (name) => {
    const { commit } = read(`${name}.run`);
    if (commit !== plan[name.split('.')[0]])
      throw new Error(`${name}.json is from ${commit}, not the plan's commit.`);
    return read(name);
  };
  for (const side of ['base', 'head']) {
    if (step === 'all' || step === side) runSide(root, plan, side, outDir);
  }
  // Both sides rerun on this host, so a slower one can't make a false loss.
  if (step === 'all' || step === 'rerun') {
    const { lost } = compareReports(plan, report('base'), report('head'));
    for (const side of ['base', 'head']) {
      rmSync(join(outDir, `${side}.rerun.json`), { force: true });
      const nodes = lost.map((l) => (side === 'base' ? l.before : l.after));
      if (nodes.length) runSide(root, plan, side, outDir, nodes);
    }
  }
  if (step === 'all' || step === 'compare') {
    const rerun = existsSync(join(outDir, 'head.rerun.json')) && {
      base: report('base.rerun'),
      head: report('head.rerun'),
    };
    const text = formatComparison(
      compareReports(plan, report('base'), report('head'), rerun),
      { base: read('base.run'), head: read('head.run') },
    );
    writeFileSync(join(outDir, 'report.md'), `${text}\n`);
    console.log(text);
  }
}
