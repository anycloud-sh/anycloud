import assert from 'node:assert/strict';
import { median } from './shared/metrics.mjs';
import { percentile, summarizeRequests } from './accounting.mjs';
import { POLICY } from './protocol.mjs';

const mean = (values) =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

export function assertDrained(run) {
  assert.equal(
    run.driver.summary.unfinished,
    0,
    'Unfinished work after drainage',
  );
  assert.equal(run.serverDrained, true, 'Observed handlers did not drain');
  assert.deepEqual(
    run.pendingAfterDrain,
    {},
    'Observed handlers remain after drainage',
  );
}

export function penaltySummary(records, deadlineMs, health = false) {
  assert(records.length, 'Missing offered samples');
  const successful = (r) => (health ? r.ok === true : r.outcome === 'success');
  const onTime = (r) =>
    successful(r) && Number.isFinite(r.elapsedMs) && r.elapsedMs <= deadlineMs;
  return {
    offered: records.length,
    failureRatePp:
      (100 * records.filter((r) => !onTime(r)).length) / records.length,
    penalizedP95Ms: percentile(
      records.map((r) =>
        onTime(r) ? Math.min(r.elapsedMs, deadlineMs) : deadlineMs,
      ),
      0.95,
    ),
    successfulP95Ms: percentile(
      records.filter(successful).map((r) => r.elapsedMs),
      0.95,
    ),
  };
}

export function trialMetrics(run, definition, health) {
  assertDrained(run);
  const values = {};
  const diagnostics = {};
  const rows = run.driver.records.filter((r) => r.sample);
  summarizeRequests(rows, POLICY.workDeadlineMs);
  if (definition.mode === 'matrix') {
    const server = new Map(run.requests.map((r) => [r.id, r]));
    for (const id of [...new Set(rows.map((r) => r.case))]) {
      const samples = rows.filter((r) => r.case === id);
      assert.equal(
        samples.length,
        definition.samples,
        'Wrong matrix sample count',
      );
      assert(
        samples.every(
          (r) =>
            r.outcome === 'success' && r.elapsedMs <= POLICY.workDeadlineMs,
        ),
        'Matrix requests must complete within their deadline',
      );
      assert(
        samples.every((r) => server.has(r.id)),
        'Missing server observation',
      );
      values[id + '/sqlMeanMs'] = mean(
        samples.map((r) => server.get(r.id).sqlMs),
      );
      values[id + '/httpP50Ms'] = percentile(
        samples.map((r) => r.elapsedMs),
        0.5,
      );
      values[id + '/httpP95Ms'] = percentile(
        samples.map((r) => r.elapsedMs),
        0.95,
      );
      diagnostics[id] = {
        responseHashes: [...new Set(samples.map((r) => r.bodySha256))],
        responseBytes: [...new Set(samples.map((r) => r.bytes))],
        queryCounts: [
          ...new Set(samples.map((r) => server.get(r.id).sqlCount)),
        ],
      };
      assert.equal(
        diagnostics[id].responseHashes.length,
        1,
        'Response varied within fixed-time trial',
      );
    }
  } else {
    const phases = ['normal', 'overload', 'recovery', 'recovery-final30'];
    const recoverySeconds = definition.phases.at(-1).seconds;
    const belongs = (r, phase) =>
      phase === 'recovery-final30'
        ? r.workPhase === 'recovery' &&
          r.phaseElapsedMs >= Math.max(0, recoverySeconds - 30) * 1000
        : r.workPhase === phase;
    const work = rows.map((r) => ({ ...r, workPhase: r.phase }));
    for (const phase of phases) {
      for (const endpoint of [...new Set(rows.map((r) => r.case)), 'health']) {
        const selected = (
          endpoint === 'health'
            ? health
            : work.filter((r) => r.case === endpoint)
        ).filter((r) => belongs(r, phase));
        assert(
          selected.length || !definition.qualifying,
          'Missing qualifying endpoint/phase offers',
        );
        const result = selected.length
          ? penaltySummary(
              selected,
              endpoint === 'health'
                ? POLICY.healthDeadlineMs
                : POLICY.workDeadlineMs,
              endpoint === 'health',
            )
          : {
              offered: 0,
              failureRatePp: null,
              penalizedP95Ms: null,
              successfulP95Ms: null,
            };
        const key = phase + '/' + endpoint;
        values[key + '/penalizedP95Ms'] = result.penalizedP95Ms;
        values[key + '/failureRatePp'] = result.failureRatePp;
        diagnostics[key] = result;
      }
    }
  }
  assert.deepEqual(
    Object.keys(values).sort(),
    definition.metrics.map((m) => m.id).sort(),
    'Missing or unexpected gated metric',
  );
  const drained =
    run.serverDrained &&
    Object.keys(run.pendingAfterDrain).length === 0 &&
    run.driver.summary.unfinished === 0;
  return { values, diagnostics, drained };
}

/** One draw selects the entire A/B pair vector, preserving all within-trial dependence. */
export function pairedIntervals(blocks, definitions) {
  assert.equal(
    blocks.length,
    POLICY.repetitions,
    'Qualification requires six complete pairs',
  );
  const vectors = blocks.map((block) =>
    definitions.map(({ id, type }) => {
      const a = block.baseline[id],
        b = block.candidate[id];
      assert(
        Number.isFinite(a) && Number.isFinite(b),
        'Non-finite paired metric: ' + id,
      );
      if (type === 'ratio') {
        assert(a > 0 && b > 0, 'Non-positive paired timing: ' + id);
        return Math.log(b / a);
      }
      return b - a;
    }),
  );
  const distributions = completePairBootstrap(vectors);
  return definitions.map((definition, index) => {
    const transform = definition.type === 'ratio' ? Math.exp : (n) => n;
    const a = blocks.map((b) => b.baseline[definition.id]);
    const b = blocks.map((b) => b.candidate[definition.id]);
    return {
      ...definition,
      estimate: transform(mean(vectors.map((v) => v[index]))),
      lower: transform(percentile(distributions[index], 0.025)),
      upper: transform(percentile(distributions[index], 0.975)),
      resamples: distributions[index].length,
      pairedValues: vectors.map((v) => transform(v[index])),
      descriptive: {
        baselineMedian: median(a),
        candidateMedian: median(b),
        ...(definition.type === 'ratio'
          ? { armMedianRatio: median(b) / median(a) }
          : { armMedianDifference: median(b) - median(a) }),
        pairedLower: a.filter((value, i) => b[i] < value).length,
        pairedEqual: a.filter((value, i) => b[i] === value).length,
        pairedHigher: a.filter((value, i) => b[i] > value).length,
      },
    };
  });
}

export function completePairBootstrap(vectors) {
  assert.equal(vectors.length, 6, 'Expected six paired vectors');
  assert(
    vectors.every((v) => v.length === vectors[0].length),
    'Inconsistent paired vectors',
  );
  const distributions = vectors[0].map(() => []);
  const draw = [];
  function enumerate(depth) {
    if (depth === 6) {
      for (let metric = 0; metric < distributions.length; metric++)
        distributions[metric].push(
          mean(draw.map((index) => vectors[index][metric])),
        );
      return;
    }
    for (let index = 0; index < 6; index++) {
      draw[depth] = index;
      enumerate(depth + 1);
    }
  }
  enumerate(0);
  return distributions;
}

export function classifyInterval(interval, calibration = false) {
  const { lower, upper, type, primary } = interval;
  if (calibration) {
    const [minimum, maximum] =
      type === 'ratio'
        ? POLICY.calibrationRatio
        : [-POLICY.rateMarginPp, POLICY.rateMarginPp];
    return lower >= minimum && upper <= maximum ? 'passes' : 'inconclusive';
  }
  const maximum =
    type === 'difference'
      ? POLICY.rateMarginPp
      : primary
        ? POLICY.benefitRatio
        : POLICY.controlRatio;
  return upper <= maximum
    ? 'passes'
    : lower > maximum
      ? 'reject'
      : 'inconclusive';
}

export function evaluatePairs(runs, definition, calibration = false) {
  const blocks = [];
  for (let repetition = 1; repetition <= POLICY.repetitions; repetition++) {
    const selected = runs.filter((r) => r.repetition === repetition);
    assert.equal(selected.length, 2, 'Incomplete or duplicate paired trial');
    const pair = Object.fromEntries(
      selected.map((r) => [r.arm, r.metrics.values]),
    );
    assert(pair.baseline && pair.candidate, 'Missing paired arm');
    blocks.push(pair);
  }
  const intervals = pairedIntervals(blocks, definition.metrics).map(
    (interval) => ({
      ...interval,
      decision: classifyInterval(interval, calibration),
    }),
  );
  const drained = runs.every((r) => r.metrics.drained);
  const decision = !drained
    ? 'inconclusive'
    : intervals.some((i) => i.decision === 'reject')
      ? 'reject'
      : intervals.some((i) => i.decision !== 'passes')
        ? 'inconclusive'
        : 'passes';
  return { decision, drained, intervals };
}
