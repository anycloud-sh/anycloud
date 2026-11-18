import { describe, expect, it } from 'vitest';
import { validateRetryAfterParsing } from '../../../scripts/check-retry-after-parsing.mjs';

const read = "const wait = Number(headers.get('retry-after'));";

describe('Retry-After parsing check', () => {
  it('rejects a private parser in src, integration tests and CI', () => {
    const violations = validateRetryAfterParsing([
      { path: 'src/api/a.ts', content: `\n${read}` },
      {
        path: 'test/integration/b.ts',
        content: `headers["X-MS-Retry-After-Ms"]`,
      },
      { path: 'ci/c.mjs', content: `get('retry-after-ms')` },
      { path: 'src/d.ts', content: 'get(`retry-after`)' },
    ]);
    expect(violations).toHaveLength(4);
    expect(violations[0]).toMatch(/^src\/api\/a\.ts:2:/);
  });

  it('allows the shared parser, listed files, prose and other trees', () => {
    expect(
      validateRetryAfterParsing([
        { path: 'src/shared/retry-after.ts', content: read },
        { path: 'src/api/server.ts', content: read },
        { path: 'src/api/a.ts', content: '/** Honours `Retry-After`. */' },
        { path: 'src/api/a.ts', content: `'x-ms-ratelimit-retry-after'` },
        { path: 'test/unit/a.spec.ts', content: read },
      ]),
    ).toEqual([]);
  });
});
