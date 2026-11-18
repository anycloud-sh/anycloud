import { JOB_BUCKET_MOLECULES } from '../targets/job-profiles.js';
import { isRecord } from '../types.js';
import { jobInvariant } from './job-records.js';

/** The pinned MACE fixture writes only these named, finite molecular energies. */
export function jobMolecules(
  value: unknown,
  runLabel: string,
): Readonly<Record<string, number>> | undefined {
  if (value === undefined) return undefined;
  jobInvariant(
    isRecord(value) &&
      value.run_label === runLabel &&
      isRecord(value.molecules),
    'MACE results are malformed or belong to another run',
  );
  const molecules: Record<string, number> = {};
  for (const [name, energy] of Object.entries(value.molecules)) {
    jobInvariant(
      JOB_BUCKET_MOLECULES.includes(name) &&
        typeof energy === 'number' &&
        Number.isFinite(energy),
      'MACE results contain a foreign molecule or invalid energy',
    );
    molecules[name] = energy;
  }
  return Object.freeze(molecules);
}

export function retainedJobMolecules(
  before: Readonly<Record<string, number>>,
  after: Readonly<Record<string, number>>,
): boolean {
  return Object.entries(before).every(
    ([name, energy]) => Object.hasOwn(after, name) && after[name] === energy,
  );
}

export function jobHydrationManifest(
  value: string | undefined,
):
  | Readonly<Record<'count' | 'bytes' | 'first' | 'middle' | 'last', string>>
  | undefined {
  if (value === undefined) return undefined;
  const fields = new Map<string, string>();
  for (const line of value.trim().split('\n')) {
    const pair = /^(count|bytes|first|middle|last)=([^=]+)$/u.exec(line);
    jobInvariant(
      pair && !fields.has(pair[1]),
      'hydration manifest contains a malformed or duplicate field',
    );
    fields.set(pair[1], pair[2]);
  }
  const field = (name: string): string => {
    const result = fields.get(name);
    jobInvariant(result, `hydration manifest is missing ${name}`);
    jobInvariant(
      (name === 'count' || name === 'bytes'
        ? /^[1-9][0-9]*$/u
        : /^[a-f0-9]{64}$/u
      ).test(result),
      `hydration manifest has an invalid ${name}`,
    );
    return result;
  };
  return Object.freeze({
    count: field('count'),
    bytes: field('bytes'),
    first: field('first'),
    middle: field('middle'),
    last: field('last'),
  });
}

/** Keep the existing probe output as the authoritative payload evidence. */
export function jobGhcrThroughput(output: string): {
  readonly fingerprint: string;
  readonly verdict: string;
} {
  const lines = output.split('\n');
  const fingerprint = lines.find((line) =>
    /^PROBE fingerprint\s+\S/u.test(line),
  );
  const verdict = lines.findLast((line) => /^PROBE verdict\s+\S/u.test(line));
  jobInvariant(
    fingerprint && verdict,
    'GHCR throughput lacks its fingerprint or verdict',
  );
  return { fingerprint, verdict };
}

export function jobGhcrPull(
  output: string,
  measureBaseline: boolean,
): {
  readonly dockerVisibility: true;
  readonly multipartSupported: true;
  readonly probeCleanup: true;
  readonly baseline: {
    readonly requested: boolean;
    readonly measured: boolean;
    readonly transferMiBs?: number;
    readonly baselineMiBs?: number;
  };
} {
  const lines = output.split('\n');
  jobInvariant(
    lines.some((line) => /^PARALLEL_PULL docker_visibility PASS\s/u.test(line)),
    'GHCR containerd pull did not prove Docker visibility',
  );
  jobInvariant(
    lines.some((line) => /^PARALLEL_PULL verdict SUPPORTED\s/u.test(line)),
    'GHCR containerd pull did not reach its supported verdict',
  );
  jobInvariant(
    lines.some((line) => /^PARALLEL_PULL cleanup PASS\s/u.test(line)),
    'GHCR automatic probe cleanup did not stop its isolated daemons',
  );
  const baseline = lines.findLast((line) =>
    line.startsWith('PARALLEL_PULL baseline '),
  );
  if (!measureBaseline) {
    jobInvariant(!baseline, 'GHCR ran an undeclared baseline comparison');
    return {
      dockerVisibility: true,
      multipartSupported: true,
      probeCleanup: true,
      baseline: { requested: false, measured: false },
    };
  }
  jobInvariant(
    baseline && !/\serror=/u.test(baseline),
    'GHCR requires a successful cold single-stream baseline',
  );
  const pull = lines.findLast((line) => line.startsWith('PARALLEL_PULL pull '));
  const throughput = (line: string | undefined) =>
    Number(/(?:^|\s)mib_per_second=([0-9.]+)(?:\s|$)/u.exec(line ?? '')?.[1]);
  const baselineMiBs = throughput(baseline);
  const transferMiBs = throughput(pull);
  jobInvariant(
    Number.isFinite(baselineMiBs) &&
      baselineMiBs > 0 &&
      Number.isFinite(transferMiBs) &&
      transferMiBs > 0,
    'GHCR requested baseline lacks comparable positive throughput',
  );
  jobInvariant(
    transferMiBs > baselineMiBs,
    'GHCR containerd transfer did not beat its declared single-stream baseline',
  );
  return {
    dockerVisibility: true,
    multipartSupported: true,
    probeCleanup: true,
    baseline: { requested: true, measured: true, transferMiBs, baselineMiBs },
  };
}
