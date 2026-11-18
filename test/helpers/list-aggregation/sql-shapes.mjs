import assert from 'node:assert/strict';

export function assertListShapeCoverage(shapes, { mode, caseIds } = {}) {
  for (const kind of ['ordinary', 'terminatable']) {
    const expected =
      mode !== 'matrix' ||
      !caseIds ||
      caseIds.some((id) => id.startsWith(kind + '-'));
    assert.equal(
      shapes[kind] > 0,
      expected,
      'Public list shape does not match the selected cases: ' + kind,
    );
  }
}

/** Observe actual built statements; never rewrite them or force their plans. */
export function classifyListStatement(sql) {
  const flat = sql.replace(/\s+/g, ' ').trim();
  const terminatable = flat.startsWith(
    'WITH terminatable_ids(id, priority) AS',
  );
  const ordinary =
    (flat.startsWith('SELECT d.*,') || flat.startsWith('WITH list_page AS')) &&
    flat.includes('latest_event_metadata');
  if (!ordinary && !terminatable) {
    assert(
      !flat.includes('latest_event_metadata'),
      'Unrecognized public list statement',
    );
    return null;
  }
  for (const fragment of [
    'd.owner_user_id',
    's.workload_id AS container_spec_owner_id',
    'LEFT JOIN container_specs s ON s.workload_id = d.id',
    'ORDER BY created_at DESC, id DESC LIMIT 1',
    'LIMIT ?',
    'FROM vms v JOIN credentials c ON c.id = v.credential_id',
  ])
    assert(
      flat.includes(fragment),
      'List statement shape changed: ' + fragment,
    );
  assert(
    !/\b(?:ssh_private_key|registry_username|registry_token|s\.env)\b/.test(
      flat,
    ),
    'Secret column in list projection',
  );
  const narrow = flat.includes('list_vm_totals AS');
  if (!narrow) {
    const alias = terminatable ? 'selected' : 'd';
    const join = 'LEFT JOIN vms v ON ' + alias + '.id = v.workload_id';
    assert.equal(
      flat.split(join).length - 1,
      1,
      'Expected one outer list join',
    );
    assert(flat.includes(join + ' GROUP BY'), 'Unexpected baseline outer join');
  } else {
    assert(
      flat.includes('LEFT JOIN list_vm_totals'),
      'Missing narrow aggregation',
    );
    assert.equal((flat.match(/list_vm_totals AS/g) ?? []).length, 1);
  }
  return { kind: terminatable ? 'terminatable' : 'ordinary', narrow };
}
