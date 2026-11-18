/**
 * Workload ID rule, shared by API admission and the CLI.
 *
 * Cap is 28 to satisfy the tightest cloud constraint (Azure): the ID is
 * suffixed with `-${index}` to form the vmId used as computerName /
 * domainNameLabel / public-IP / NIC names, and 28 leaves room for a 3-digit
 * index (up to 999 VMs/workload) within Azure's safe vmId budget.
 */
const MAX_WORKLOAD_ID_LENGTH = 28;

const WORKLOAD_ID_PATTERN = /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/;

/**
 * Why `id` is not a valid workload ID, as a predicate that follows its
 * subject ("is 29 characters; …"), or undefined when it is valid.
 */
export function workloadIdProblem(id: string): string | undefined {
  if (!id) return 'cannot be empty.';
  if (id.length > MAX_WORKLOAD_ID_LENGTH) {
    return `is ${id.length} characters; the limit is ${MAX_WORKLOAD_ID_LENGTH}.`;
  }
  if (!WORKLOAD_ID_PATTERN.test(id)) {
    return 'must contain only lowercase letters, numbers and hyphens, and must start and end with a letter or number.';
  }
  return undefined;
}
