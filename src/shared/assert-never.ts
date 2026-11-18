/**
 * Exhaustiveness backstop. In the `default:` of a switch over a finite union
 * (e.g. CloudType), `assertNever(x)` makes the compiler reject any unhandled
 * case: if a case is missing, `x` is no longer `never` and the call fails to
 * typecheck. Turns "forgot to handle a provider" into a build error instead of a
 * silent runtime fallthrough.
 */
export function assertNever(x: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(x)}`);
}
