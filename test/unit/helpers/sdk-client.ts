/**
 * Stand-ins for the cloud SDK clients a gateway talks to.
 */

/**
 * Build a fake SDK client from only the operations a test drives.
 *
 * The provider SDKs ship these as classes: dozens of operation groups, dozens
 * of methods each, and private fields no object literal can ever satisfy. A
 * spec that exercises one call cannot supply the rest, so the shape is
 * deliberately unchecked below the top level.
 *
 * What stays checked is the names, which is where the mistakes actually are. A
 * fake registered under an operation the client does not have is never reached,
 * the real one runs instead, and the test passes for the wrong reason — so it
 * is worth a compile error even when nothing deeper can be.
 *
 * `NoInfer` keeps the client type coming from what the fake is assigned to
 * rather than from the fake itself, which would make the check vacuous.
 */
export function fakeSdkClient<T>(operations: {
  [K in keyof NoInfer<T>]?: unknown;
}): T {
  const client: unknown = operations;
  return client as T;
}
