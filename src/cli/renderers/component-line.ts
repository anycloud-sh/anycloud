/** One ✓/◌/✗ line for a component `status` checks, such as a container. */
export function componentLine(
  label: string,
  ok: boolean,
  pending: boolean,
  text: string,
): string {
  return `${pending ? '◌' : ok ? '✓' : '✗'} ${label}  ${text}`;
}
