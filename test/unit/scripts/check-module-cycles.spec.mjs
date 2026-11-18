import { describe, expect, it } from 'vitest';
import { runScriptInTree } from '../../helpers/run-script-in-tree.mjs';

const check = (files) =>
  runScriptInTree('scripts/check-module-cycles.mjs', files);

describe('module cycle check', () => {
  it('accepts an acyclic graph, including type-only and package imports', () => {
    const result = check({
      'src/a.ts': "import { b } from './b.js';\nimport ts from 'typescript';",
      'src/b.ts': "export { c } from './lib/index.js';",
      'src/lib/index.ts': "import type { View } from './view.js';",
      'src/lib/view.tsx': 'export const View = 1;',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('passed (4 source modules)');
  });

  it('rejects a cycle through re-exports, index files, and .tsx modules', () => {
    const result = check({
      'src/a.ts': "import { b } from './b.js';",
      'src/b.ts': "export * from './lib/index.js';",
      'src/lib/index.ts': "export { View } from './view.js';",
      'src/lib/view.tsx': "import { a } from '../a.js';",
      'src/outside.ts': "import { a } from './a.js';",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      'Source module cycles are not allowed.\nCycle 1:\n' +
        '  src/a.ts\n  src/b.ts\n  src/lib/index.ts\n  src/lib/view.tsx\n',
    );
  });

  it('rejects a module that imports itself and reports each cycle', () => {
    const result = check({
      'src/self.ts': "import { x } from './self.js';",
      'src/x.ts': "import { y } from './y.js';",
      'src/y.ts': "import { x } from './x.js';",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('  src/self.ts\n');
    expect(result.stderr).toContain('  src/x.ts\n  src/y.ts\n');
    expect(result.stderr).toMatch(/Cycle 2:/);
  });
});
