import { type Command, InvalidArgumentError, Option } from 'commander';
import type { JobSpecInput } from '../../shared/api-contract/workload-admission-schemas.js';
import { parseDurationMs } from '../utils/duration.js';

export type JobSpecOptions = Omit<JobSpecInput, 'mounts'> & {
  mount?: JobSpecInput['mounts'];
};

function positiveInteger(flag: string) {
  return (value: string): number => {
    if (!/^[1-9][0-9]*$/.test(value)) {
      throw new InvalidArgumentError(`${flag} must be a positive integer.`);
    }
    return Number(value);
  };
}

/** `NAME:PATH[:ro]`, where NAME is `state` or an absolute path. */
function parseMount(
  value: string,
  previous: NonNullable<JobSpecInput['mounts']> = [],
): NonNullable<JobSpecInput['mounts']> {
  const [name, path, mode, ...rest] = value.split(':');
  if (
    !name ||
    !(name === 'state' || name.startsWith('/')) ||
    !path?.startsWith('/') ||
    (mode !== undefined && mode !== 'ro') ||
    rest.length > 0
  ) {
    throw new InvalidArgumentError(
      '--mount must look like state:/state or /host/path:/path[:ro].',
    );
  }
  return [...previous, { name, path, ...(mode && { ro: true }) }];
}

/** Whole seconds; a bare number would be days to `parseDurationMs`. */
const parseWholeSeconds =
  (flag: string) =>
  (value: string): number => {
    if (!/^\d+(ms|s|m|h|d)$/.test(value.trim())) {
      throw new InvalidArgumentError(
        `${flag} needs a unit, such as 90s, 30m or 24h.`,
      );
    }
    const ms = parseDurationMs(value);
    if (ms < 1000 || ms % 1000 !== 0) {
      throw new InvalidArgumentError(
        `${flag} must be a whole number of seconds, at least 1s.`,
      );
    }
    return ms / 1000;
  };

/**
 * RFC 0046's neutral Job spec flags. They stay hidden from `--help` until a
 * substrate admits one; until then admission refuses them, naming the flag.
 */
export function addJobSpecOptions(command: Command): Command {
  return command
    .addOption(
      new Option('--nodes <count>', 'Machines the Job spans')
        .argParser(positiveInteger('--nodes'))
        .hideHelp(),
    )
    .addOption(
      new Option('--gpus-per-node <count>', 'GPUs on each node')
        .argParser(positiveInteger('--gpus-per-node'))
        .hideHelp(),
    )
    .addOption(
      new Option('--launch <mode>', 'Processes per node')
        .choices(['single', 'distributed'])
        .hideHelp(),
    )
    .addOption(
      new Option(
        '--mount <NAME:PATH[:ro]>',
        'Mount state or a path (repeatable)',
      )
        .argParser(parseMount)
        .hideHelp(),
    )
    .addOption(
      new Option('--time-limit <duration>', 'Longest one attempt may run')
        .argParser(parseWholeSeconds('--time-limit'))
        .hideHelp(),
    )
    .addOption(
      new Option(
        '--resumable',
        'Retry an attempt that reaches its time limit',
      ).hideHelp(),
    );
}

export function jobSpecRequest(options: JobSpecOptions): JobSpecInput {
  return {
    nodes: options.nodes,
    gpusPerNode: options.gpusPerNode,
    launch: options.launch,
    mounts: options.mount,
    timeLimit: options.timeLimit,
    resumable: options.resumable,
  };
}
