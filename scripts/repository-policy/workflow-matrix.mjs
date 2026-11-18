// Expands a GitHub Actions `strategy.matrix` into its concrete rows the way
// the runner does: the cartesian product of the list dimensions, minus
// `exclude` entries, with `include` entries merged onto matching rows or
// appended as new rows. Workflow policy tests use it to reason about every
// leg a job will actually run.

function deepEqual(left, right) {
  if (left === right) return true;
  if (
    !left ||
    !right ||
    typeof left !== 'object' ||
    typeof right !== 'object' ||
    Array.isArray(left) !== Array.isArray(right)
  ) {
    return false;
  }
  if (Array.isArray(left)) {
    return (
      left.length === right.length &&
      left.every((value, index) => deepEqual(value, right[index]))
    );
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    JSON.stringify(leftKeys) === JSON.stringify(rightKeys) &&
    leftKeys.every((key) => deepEqual(left[key], right[key]))
  );
}

export function matrixRows(matrix) {
  if (!matrix) return [{}];
  if (typeof matrix !== 'object' || Array.isArray(matrix)) return [];
  const dimensions = Object.entries(matrix).filter(
    ([key, values]) =>
      !['include', 'exclude'].includes(key) && Array.isArray(values),
  );
  let originals = [{}];
  for (const [key, values] of dimensions) {
    originals = originals.flatMap((row) =>
      values.map((value) => ({ ...row, [key]: value })),
    );
  }
  const excluded = Array.isArray(matrix.exclude) ? matrix.exclude : [];
  originals = originals.filter(
    (row) =>
      !excluded.some(
        (entry) =>
          entry &&
          Object.entries(entry).every(([key, value]) =>
            deepEqual(row[key], value),
          ),
      ),
  );
  if (dimensions.length === 0) originals = [];
  const rows = originals.map((row) => ({ ...row }));
  for (const entry of Array.isArray(matrix.include) ? matrix.include : []) {
    if (!entry || typeof entry !== 'object') continue;
    let applied = false;
    originals.forEach((original, index) => {
      if (
        Object.entries(entry).every(
          ([key, value]) =>
            !Object.hasOwn(original, key) || deepEqual(original[key], value),
        )
      ) {
        rows[index] = { ...rows[index], ...entry };
        applied = true;
      }
    });
    if (!applied) rows.push({ ...entry });
  }
  return rows;
}
