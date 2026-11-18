import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OPENAPI_PATH } from '../../../scripts/generate-openapi.js';
import {
  changes,
  type OpenApi,
  renderOpenApiDiff,
} from '../../../scripts/openapi-diff.js';

const committed = (): OpenApi =>
  JSON.parse(readFileSync(OPENAPI_PATH, 'utf8')) as OpenApi;
const ops = (doc: OpenApi) =>
  Object.entries<OpenApi>(doc.paths).flatMap(([path, methods]) =>
    Object.entries<OpenApi>(methods).map(([method, op]) => ({
      name: `${method.toUpperCase()} ${path}`,
      op,
    })),
  );
const addError = (op: OpenApi, code: string, status: string) => {
  const ref = `#/components/schemas/${code}ApiError`;
  op.responses[status] ??= {
    description: status,
    content: {
      'application/json': {
        schema: {
          oneOf: [],
          discriminator: { propertyName: 'code', mapping: {} },
        },
      },
    },
  };
  const schema = op.responses[status].content['application/json'].schema;
  schema.oneOf.unshift({ $ref: ref });
  schema.discriminator.mapping[code] = ref;
};
const isWorkload = (op: OpenApi) => 'workloadBearer' in op.security[0];

describe('renderOpenApiDiff', () => {
  it('reports an error added on both bases once, with exact counts', () => {
    const after = committed();
    for (const { op } of ops(after)) addError(op, 'SERVICE_DRAINING', '503');
    after.components.schemas.SERVICE_DRAININGApiError = { type: 'object' };
    const total = ops(after).length;
    const replicas = ops(after).filter(({ op }) => isWorkload(op)).length;

    const section = renderOpenApiDiff(committed(), after);

    expect(section).toContain(
      `- \`authenticatedContract\`, \`workloadContract\`: + error \`SERVICE_DRAINING\` (503) → ${total} endpoints (${replicas} replica ⚠️)`,
    );
    // The new 503 status on workload endpoints rides on the error line.
    expect(section).not.toContain('status 503');
    expect(section).toContain(
      `- + schema \`SERVICE_DRAININGApiError\` → ${total} endpoints`,
    );
    expect(section).toContain(`Changes ${replicas} replica routes`);
  });

  it('attributes a tag-wide error to the tag and a single one to its endpoint', () => {
    const after = committed();
    const secrets = ops(after).filter(({ op }) => op.tags[0] === 'Secrets');
    for (const { op } of secrets) addError(op, 'SecretLockedApiError', '409');
    const [first] = ops(after).filter(({ op }) => op.tags[0] === 'Clusters');
    addError(first.op, 'ClusterLockedApiError', '409');

    const section = renderOpenApiDiff(committed(), after);

    expect(section).toContain(
      `- \`Secrets\` endpoints: + error \`SecretLockedApiError\` (409) → ${secrets.length} endpoints\n`,
    );
    expect(section).toContain(
      `- \`${first.name}\`: + error \`ClusterLockedApiError\` (409)`,
    );
    expect(section).not.toContain('⚠️ Changes');
  });

  it('lists removed endpoints before per-endpoint changes and caps the list', () => {
    const before = committed();
    const after = committed();
    const [removed, ...rest] = ops(after);
    delete after.paths[removed.name.split(' ')[1]][
      removed.name.split(' ')[0].toLowerCase()
    ];
    for (const [i, { op }] of rest.slice(0, 40).entries())
      op.summary = `Summary ${i}`;

    const section = renderOpenApiDiff(before, after);

    expect(section).toContain(`- − endpoint \`${removed.name}\``);
    expect(section.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(
      25,
    );
    expect(section).toMatch(
      /- \+\d+ more; see the diff of the committed spec\./,
    );
  });

  it('reports a non-error change to an error response', () => {
    const after = committed();
    const [first] = ops(after);
    first.op.responses['401'].description = 'Not signed in';
    expect(renderOpenApiDiff(committed(), after)).toContain(
      `- \`${first.name}\`: + 401 response details`,
    );
  });

  it('counts the endpoints of a changed security scheme', () => {
    const after = committed();
    after.components.securitySchemes.workloadBearer.description = 'Changed';
    const replicas = ops(after).filter(({ op }) => isWorkload(op)).length;
    expect(renderOpenApiDiff(committed(), after)).toContain(
      `- securityScheme \`workloadBearer\`: ~ schema → ${replicas} endpoints (${replicas} replica ⚠️)`,
    );
  });

  it('reports changes outside paths and components', () => {
    const after = committed();
    after.info.title = 'Renamed';
    expect(renderOpenApiDiff(committed(), after)).toContain(
      '- other spec changes: `info`',
    );
  });

  it('reports no change for equal documents', () => {
    expect(renderOpenApiDiff(committed(), committed())).toBe(
      '### API contract\n\nNo API contract change.',
    );
  });
});

describe('changes', () => {
  // Changing any scalar, removing any key or element, or adding to any object
  // or array, of any operation or component is a change some line names.
  it('names every change to the committed document', () => {
    const document = committed();
    const items = [
      ...ops(document).map(({ op }) => op),
      ...Object.values<OpenApi>(document.components).flatMap((kind) =>
        Object.values<OpenApi>(kind),
      ),
    ];
    let mutations = 0;
    const check = (
      root: OpenApi,
      path: string[],
      mutate: (at: any) => void,
    ) => {
      const mutated = structuredClone(root);
      mutate(path.reduce((at, key) => at[key], mutated));
      mutations++;
      expect(changes(root, mutated), path.join('.')).not.toHaveLength(0);
    };
    const visit = (root: OpenApi, path: string[]) => {
      const value = path.reduce((at, key) => at[key], root);
      if (typeof value !== 'object' || value === null) return;
      check(root, path, (at) =>
        Array.isArray(at) ? at.push('added') : (at['x-added'] = true),
      );
      for (const key of Object.keys(value)) {
        check(root, path, (at) =>
          Array.isArray(at) ? at.splice(Number(key), 1) : delete at[key],
        );
        if (typeof value[key] !== 'object')
          check(root, path, (at) => {
            at[key] = `${at[key]}-changed`;
          });
        visit(root, [...path, key]);
      }
    };
    for (const item of items) visit(item, []);
    expect(mutations).toBeGreaterThan(1000);
  });
});
