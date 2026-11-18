/**
 * View an object through the private members a spec drives.
 *
 * Private methods are private because production code outside the class has no
 * business calling them; a spec stubbing one is reaching past that on purpose,
 * to observe what the public path does with the result.
 *
 * Declare the view by borrowing each type from the class — `{ send: Client['send'] }`
 * — rather than restating a signature. Then a stub stops compiling when the real
 * call changes shape, which is the reason to name the surface at all instead of
 * casting the object to `any` at each site.
 */
export function internalsOf<T>(instance: object): T {
  const exposed: unknown = instance;
  return exposed as T;
}
