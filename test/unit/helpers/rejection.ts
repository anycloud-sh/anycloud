/**
 * Await work that must reject, and return the error it rejected with.
 *
 * `.catch((error) => error)` also resolves when the work succeeds, which is the
 * failure mode this rules out: a spec asserting on an error the code no longer
 * throws goes on reporting green, having asserted against the return value.
 */
export async function rejectionOf(
  work: Promise<unknown>,
): Promise<Error & { code?: string }> {
  try {
    await work;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`expected an Error, got ${typeof error}: ${String(error)}`);
  }
  throw new Error('expected the call to reject, but it resolved');
}
