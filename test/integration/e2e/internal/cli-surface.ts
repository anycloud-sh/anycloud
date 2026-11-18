import { cliSurface, type CliSurface } from './cli-surface.generated.js';

export type CliPath = keyof CliSurface;

type Spec<P extends CliPath> = CliSurface[P]['options'][number];
type Name<S extends string> = S extends `${infer N}=!`
  ? N
  : S extends `${infer N}=`
    ? N
    : S;
type Mandatory<S extends string> = S extends `${string}=!` ? S : never;
type Elective<S extends string> = S extends `${string}=!` ? never : S;
type Value<S extends string> = S extends `${string}=${string}`
  ? string | readonly string[]
  : boolean;

/**
 * The options one command accepts, by long flag without `--`: a value option
 * takes a string (or several, repeated), a switch takes a boolean, a
 * `requiredOption` must be present. Anything else is a compile error.
 */
export type CliOptions<P extends CliPath> = {
  readonly [S in Mandatory<Spec<P>> as Name<S>]: string | readonly string[];
} & {
  readonly [S in Elective<Spec<P>> as Name<S>]?: Value<S> | undefined;
};

const optionName = (spec: string): string => spec.replace(/=!?$/u, '');

/**
 * argv for one CLI command: the path, its flags, its positionals and, after
 * `--`, the container command when there is one — the order the harness has
 * always used (flags first, the image last before `--`), which the tracked
 * mutation authorizers and the unit fakes read. Known flags only: the type
 * rejects the rest and the runtime double-checks it; `undefined`, `false` and
 * empty lists are left out.
 */
export function cliArgs<P extends CliPath>(
  path: P,
  options: CliOptions<P>,
  positionals: readonly string[] = [],
  passthrough: readonly string[] = [],
): string[] {
  const entry = cliSurface[path];
  const specs = new Map(
    entry.options.map((spec: string) => [optionName(spec), spec] as const),
  );
  const required = entry.args.filter((arg: string) => arg.startsWith('<'));
  const variadic = entry.args.some((arg: string) => arg.includes('...'));
  if (
    positionals.length < required.length ||
    (!variadic && positionals.length > entry.args.length)
  ) {
    throw new Error(
      `anycloud ${path} takes ${entry.args.join(' ') || 'no positionals'}, not ${String(positionals.length)}`,
    );
  }
  const flags: string[] = [];
  const given: Record<string, unknown> = options;
  for (const [name, value] of Object.entries(given)) {
    const spec = specs.get(name);
    if (spec === undefined) {
      throw new Error(`anycloud ${path} has no --${name} option`);
    }
    if (value === undefined || value === false) continue;
    if (spec.includes('=')) {
      if (typeof value !== 'string' && !Array.isArray(value)) {
        throw new Error(`anycloud ${path} --${name} takes a value`);
      }
      const values: unknown[] = typeof value === 'string' ? [value] : value;
      for (const each of values) {
        if (typeof each !== 'string') {
          throw new Error(`anycloud ${path} --${name} takes strings`);
        }
        flags.push(`--${name}`, each);
      }
    } else if (value === true) {
      flags.push(`--${name}`);
    } else {
      throw new Error(`anycloud ${path} --${name} is a switch`);
    }
  }
  for (const spec of entry.options) {
    if (spec.endsWith('!') && !(optionName(spec) in options)) {
      throw new Error(`anycloud ${path} requires --${optionName(spec)}`);
    }
  }
  return [
    ...path.split(' '),
    ...flags,
    ...positionals,
    ...(passthrough.length > 0 ? ['--', ...passthrough] : []),
  ];
}
