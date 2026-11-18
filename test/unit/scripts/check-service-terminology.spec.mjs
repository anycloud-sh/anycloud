import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { validateServiceTerminology } from '../../../scripts/check-service-terminology.mjs';

describe('canonical Service terminology check', () => {
  it('preserves the reviewed socket trace only at its exact path and bytes', () => {
    const path = 'benchmarks/list-responsiveness/native-diagnosis-summary.json';
    const content = readFileSync(
      new URL('../../../' + path, import.meta.url),
      'utf8',
    );
    expect(validateServiceTerminology([{ path, content }])).toEqual([]);
    expect(
      validateServiceTerminology([
        { path, content: content.replace('socket-1', 'socket-changed') },
      ]),
    ).toHaveLength(3);
    expect(
      validateServiceTerminology([{ path: 'src/example.json', content }]),
    ).toHaveLength(3);
  });

  it('accepts canonical workload values and aggregates', () => {
    expect(
      validateServiceTerminology([
        {
          path: 'src/example.ts',
          content: `const type = 'service';\nconst counts = { services: 1, totalServices: 1 };`,
        },
      ]),
    ).toEqual([]);
  });

  it('rejects legacy discriminators, aliases, and aggregate names', () => {
    // service-terminology-ok: these strings are the checker's rejection fixtures
    const violations = validateServiceTerminology([
      {
        path: 'src/example.ts',
        // service-terminology-ok: checker rejection fixtures below
        content: [
          `const type = 'server';`,
          'const type2 = WorkloadType.Server;',
          'const counts = { servers: 1, totalServers: 1 };',
        ].join('\n'),
      },
    ]);

    expect(violations.map(({ line }) => line)).toEqual([1, 2, 3]);
  });

  it('requires an explicit reason for a technical exception', () => {
    expect(
      validateServiceTerminology([
        {
          path: 'src/provider.ts',
          content: `// service-terminology-ok: provider-owned SKU\nconst sku = 'server';`,
        },
      ]),
    ).toEqual([]);
  });
});
