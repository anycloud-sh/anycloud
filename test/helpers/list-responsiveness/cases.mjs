import assert from 'node:assert/strict';
import { BUSINESS_NOW, HOUR, PRIMARY } from './fixture.mjs';

function list(id, query = {}, extra = {}) {
  const params = new URLSearchParams(
    Object.entries(query).map(([key, value]) => [key, String(value)]),
  );
  return {
    id,
    path: '/v1/workloads' + (params.size ? '?' + params : ''),
    ...extra,
  };
}

export function matrixCases() {
  return ['ordinary', 'terminatable'].flatMap((kind) =>
    [undefined, 1, 200, 1000].map((limit) =>
      list(`${kind}-${limit ?? 'default'}`, {
        ...(kind === 'terminatable' ? { stateClass: kind } : {}),
        ...(limit === undefined ? {} : { limit }),
      }),
    ),
  );
}

export function loadCases(fixture) {
  return [
    list('ordinary-1000', { limit: 1000 }),
    list('terminatable-1000', { stateClass: 'terminatable', limit: 1000 }),
    list('session-1000', { session: fixture.session, limit: 1000 }),
    {
      id: 'daily-cost',
      path: `/v1/workload-costs?sinceMs=${BUSINESS_NOW - 24 * HOUR}`,
    },
    { id: 'terminal-status', path: `/v1/workloads/${fixture.statusId}` },
  ];
}

export function correctnessCases(scope) {
  const edges = { session: 'edges', limit: 1000 };
  return [
    list('edges', edges),
    list('empty-result', { filter: 'no-matching-fixture-exists' }),
    list('default'),
    list('explicit-three', { limit: 3 }),
    ...[undefined, 1, 200, 1000].map((limit) =>
      list(`headroom-${limit ?? 'default'}`, {
        session: 'headroom',
        ...(limit === undefined ? {} : { limit }),
      }),
    ),
    list('limit-clamped', { session: 'limits', limit: 1001 }),
    list('period-boundary', { sinceMs: BUSINESS_NOW - HOUR, limit: 1000 }),
    list('period-empty', { sinceMs: BUSINESS_NOW + 1 }),
    list('terminatable', { ...edges, stateClass: 'terminatable' }),
    list('terminatable-one', { stateClass: 'terminatable', limit: 1 }),
    list('terminatable-period', {
      stateClass: 'terminatable',
      sinceMs: BUSINESS_NOW - HOUR,
    }),
    list('resubmittable', { ...edges, stateClass: 'resubmittable' }),
    list('credential-null', { ...edges, credentialName: 'list-azure' }),
    list('provider-fallback', { ...edges, filter: 'Azure' }),
    list('session-prefix', { session: 'claude:shared-111111', limit: 1000 }),
    list('session-exact', {
      session: 'claude:shared-111111',
      sessionExact: true,
    }),
    list('session-label', { session: 'Literal label' }),
    list('agent', { agent: 'codex' }),
    list('renamed-user', { user: 'old-account-name' }),
    list('durable-user', { user: '1', ...edges }),
    list('literal-search', { filter: '%_canary' }),
    ...['job', 'service', 'vm'].map((workloadType) =>
      list(`type-${workloadType}`, { ...edges, workloadType }),
    ),
    list('status', { ...edges, status: 'FAILED' }),
    list('missing-auth', {}, { token: null, expectedStatus: 401 }),
    list('invalid-limit', { limit: 0 }, { expectedStatus: 400 }),
    list('invalid-status', { status: 'made-up' }, { expectedStatus: 400 }),
    list(
      'invalid-credential',
      { credentialName: 'no-such-name' },
      { expectedStatus: 400 },
    ),
    list(
      'incompatible-version',
      {},
      { version: '0.0.0', expectedStatus: 'error' },
    ),
    list(
      'other-authenticated-user',
      {},
      {
        token: 'test-token:not-admitted',
        expectedStatus: scope === 'api' ? 403 : 200,
      },
    ),
    ...(scope === 'api'
      ? [list('admitted-peer', edges, { token: 'test-token:list-peer' })]
      : []),
  ];
}

export function checkResponse(testCase, data, status, scope) {
  if (testCase.expectedStatus === 'error') {
    assert(status >= 400);
    return;
  }
  assert.equal(
    status,
    testCase.expectedStatus ?? 200,
    testCase.id + ': status',
  );
  if (status !== 200) return;
  assert(Array.isArray(data));
  const ids = data.map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length, 'Duplicate workload');
  for (let i = 1; i < data.length; i++) {
    assert(
      data[i - 1].startedAt > data[i].startedAt ||
        (data[i - 1].startedAt === data[i].startedAt &&
          data[i - 1].id > data[i].id),
      'Newest-first deterministic ordering',
    );
  }
  for (const row of data) {
    for (const key of [
      'env',
      'githubToken',
      'registryUsername',
      'sshPrivateKey',
    ]) {
      assert(!Object.hasOwn(row, key), key);
    }
    assert.equal(row.version, null);
    assert.equal(typeof row.isOwnedByCaller, 'boolean');
    assert(!JSON.stringify(row).includes('list-secret-key-canary'));
    assert(!JSON.stringify(row).includes('list-env-canary'));
  }
  const byId = (id) => {
    const row = data.find((item) => item.id === id);
    assert(row, testCase.id + ': missing ' + id);
    return row;
  };
  if (testCase.id === 'edges') {
    for (const id of [
      'list-no-vms',
      'list-null-only',
      'list-credential-null',
    ]) {
      const row = byId(id);
      assert.equal(row.vmCount, 0);
      assert.equal(row.vmDurationMs, 0);
      assert.equal(row.totalCost, 0);
      assert.equal(row.awaitingReleaseMs, 0);
      assert.equal(row.costSource, 'actual');
    }
    assert.equal(byId('list-null-only').cloudProvider, 'Azure');
    assert.equal(byId('list-empty-ip').vmCount, 1);
    assert.equal(byId('list-empty-ip').totalCost, 2);
    assert.equal(byId('list-empty-ip').vmDurationMs, HOUR);
    assert.equal(byId('list-empty-ip').costSource, 'estimated');
    const mixed = byId('list-mixed');
    assert.equal(mixed.vmCount, 1);
    assert.equal(mixed.vmDurationMs, 6 * HOUR);
    assert.equal(mixed.awaitingReleaseMs, HOUR);
    assert.equal(mixed.totalCost, 6);
    assert.equal(mixed.costSource, 'estimated');
    assert.equal(byId('list-refund').totalCost, -2);
    assert.equal(byId('list-actual').costSource, 'actual');
    assert.equal(byId('list-unpriced').totalCost, 0);
    assert.equal(byId('list-unpriced').vmDurationMs, HOUR);
    assert.equal(byId('list-renamed').isOwnedByCaller, true);
    assert.equal(byId('list-legacy').isOwnedByCaller, true);
    if (scope === 'api')
      assert.equal(byId('list-other-id-same-name').isOwnedByCaller, false);
    else
      assert(
        !ids.includes('list-other-id-same-name') &&
          !ids.includes('list-other-user'),
      );
    assert.equal(byId('list-event-tie-z').latestMessage, 'winning message');
  }
  if (testCase.id === 'headroom-default' || testCase.id === 'headroom-1000')
    assert.equal(data.length, 225);
  if (testCase.id === 'headroom-200') assert.equal(data.length, 200);
  if (testCase.id === 'headroom-1') assert.equal(data.length, 1);
  if (testCase.id === 'limit-clamped') assert.equal(data.length, 1000);
  if (testCase.id === 'explicit-three') assert.equal(data.length, 3);
  if (
    testCase.id === 'empty-result' ||
    testCase.id === 'period-empty' ||
    (testCase.id === 'other-authenticated-user' && scope === 'user')
  )
    assert.equal(data.length, 0);
  if (testCase.id === 'period-boundary') {
    byId('list-event-tie-a');
    byId('list-event-tie-z');
    assert(data.every((row) => row.startedAt >= BUSINESS_NOW - HOUR));
  }
  if (testCase.id === 'resubmittable') {
    byId('list-no-vms');
    assert(!ids.includes('list-null-blocker'));
    assert(!ids.includes('list-vm'));
  }
  if (
    testCase.id === 'credential-null' ||
    testCase.id === 'provider-fallback'
  ) {
    byId('list-credential-null');
    byId('list-null-only');
  }
  if (testCase.id === 'terminatable') {
    byId('list-null-only');
    byId('list-pending');
    assert(!ids.includes('list-no-vms'));
  }
  if (testCase.id === 'session-exact' || testCase.id === 'literal-search')
    assert.deepEqual(ids, ['list-search']);
  if (testCase.id === 'renamed-user') assert.deepEqual(ids, ['list-renamed']);
  if (testCase.id === 'admitted-peer')
    assert(data.every((row) => !row.isOwnedByCaller));
  if (testCase.id.startsWith('type-'))
    assert(data.every((row) => row.workloadType === testCase.id.slice(5)));
  if (testCase.id === 'status')
    assert(data.every((row) => row.state === 'failed'));
}

export function requestHeaders(testCase, version, id, phase) {
  const token = testCase.token === undefined ? PRIMARY.token : testCase.token;
  return {
    ...(token ? { Authorization: 'Bearer ' + token } : {}),
    'AnyCloud-Client-Version': testCase.version ?? version,
    'X-List-Spike-Request': id,
    'X-List-Spike-Case': testCase.id,
    'X-List-Spike-Phase': phase,
  };
}
