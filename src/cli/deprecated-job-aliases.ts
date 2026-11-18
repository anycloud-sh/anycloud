// One-release compatibility for 0.1.64 scripts; a later release removes this.
const DEPRECATED_JOB_ALIASES = new Set(['run', 'submit']);

/** Rewrites `anycloud run|submit` to `anycloud job` after warning on stderr. */
export function rewriteDeprecatedJobAlias(
  argv: string[],
  warn: (message: string) => void,
): void {
  const name = argv[2];
  if (name === undefined || !DEPRECATED_JOB_ALIASES.has(name)) return;
  warn(
    `\`anycloud ${name}\` is deprecated; use \`anycloud job\`. It will be removed in a future release.`,
  );
  argv[2] = 'job';
}
