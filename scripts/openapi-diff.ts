// Prints the API contract section CONTRIBUTING.md requires: what changed
// between the committed OpenAPI document at the merge base and the branch's,
// reported where it was declared. `yarn pr:sections` prints it.

import { USER_OPENAPI_SECURITY_SCHEME } from '../src/shared/api-contract/base.js';
import { canonicalJson } from './generate-openapi.js';

/** OpenAPI documents are untyped JSON here. */
type Item = Record<string, any>;
export type OpenApi = Item;

/** The security scheme `base.ts` attaches to every endpoint. */
const BASES: Record<string, string> = {
  [USER_OPENAPI_SECURITY_SCHEME]: 'authenticatedContract',
};
const MAX_LINES = 25;
const code = (text: string) => `\`${text}\``;
/** Key order is not part of the wire. */
const json = (value: unknown) => canonicalJson(value) ?? 'undefined';

/**
 * Flattens an operation or component into labelled facts, so a change reads
 * as one line. Whatever no specific fact covers stays in a residual fact, so
 * every change to the item changes at least one fact.
 */
function facts(item: Item): Map<string, string> {
  const out = new Map<string, string>();
  const fields = (prefix: string, schema: Item) => {
    if (!schema.properties)
      return void out.set(prefix || 'schema', json(schema));
    const { properties, required = [], ...rest } = schema;
    const unlisted = required.filter((name: string) => !properties[name]);
    if (unlisted.length) rest.required = unlisted;
    for (const [name, property] of Object.entries<Item>(properties))
      out.set(
        `${prefix} field ${code(name)}`.trim(),
        `${json(property)}${required.includes(name) ? ' required' : ''}`,
      );
    if (Object.keys(rest).length) out.set(prefix || 'schema', json(rest));
  };
  /** Moves the JSON schema out of a request body or response. */
  const take = (part: Item) => {
    const { schema, ...media } = part.content?.['application/json'] ?? {};
    if (!schema) return [undefined, part] as const;
    return [
      schema as Item,
      { ...part, content: { ...part.content, 'application/json': media } },
    ] as const;
  };
  if (!item.responses) {
    fields('', item);
    return out;
  }
  const { parameters = [], requestBody, responses, ...rest } = item;
  for (const parameter of parameters)
    out.set(
      `parameter ${code(parameter.$ref?.split('/').pop() ?? `${parameter.in} ${parameter.name}`)}`,
      json(parameter),
    );
  if (requestBody) {
    const [schema, residual] = take(requestBody);
    if (schema) fields('request', schema);
    out.set('request body', json(residual));
  }
  for (const [status, response] of Object.entries<Item>(responses)) {
    const [schema, residual] = take(response);
    const { mapping, ...discriminator } = schema?.discriminator ?? {};
    for (const [error, reference] of Object.entries(mapping ?? {}))
      out.set(`error ${code(error)} (${status})`, json(reference));
    if (mapping) {
      const { oneOf = [], discriminator: _, ...keywords } = schema!;
      // Each mapped error should appear once in `oneOf` as a bare `$ref`.
      const missing = new Set(Object.values(mapping));
      const others = oneOf.filter(
        (r: Item) => Object.keys(r).length > 1 || !missing.delete(r.$ref),
      );
      const shell = json({
        residual,
        discriminator,
        keywords,
        others,
        missing: [...missing],
      });
      // The generator's plain error response says nothing its errors do not.
      if (shell !== plainErrorResponse(status))
        out.set(`${status} response details`, shell);
    } else {
      if (schema) fields(`response ${status}`, schema);
      out.set(`status ${status}`, json(residual));
    }
  }
  for (const [key, value] of Object.entries(rest))
    out.set(code(key), json(value));
  return out;
}

const plainErrorResponse = (status: string) =>
  json({
    residual: { content: { 'application/json': {} }, description: status },
    discriminator: { propertyName: 'code' },
    keywords: {},
    others: [{ $ref: '#/components/schemas/UndefinedApiError' }],
    missing: [],
  });

/**
 * Signed change lines between two items, such as `+ error X (503)`, each with
 * a key that also holds the values, so only identical changes group together.
 */
export function changes(before: Item, after: Item) {
  const [a, b] = [facts(before), facts(after)];
  return [...new Set([...a.keys(), ...b.keys()])].flatMap((fact) => {
    const [x, y] = [a.get(fact), b.get(fact)];
    if (x === y) return [];
    const line = `${x === undefined ? '+' : y === undefined ? '−' : '~'} ${fact}`;
    return [{ line, key: `${line}\0${x}\0${y}` }];
  });
}

const operations = (doc: OpenApi) =>
  new Map<string, Item>(
    Object.entries<Item>(doc.paths ?? {}).flatMap(([path, methods]) =>
      Object.entries<Item>(methods).map(
        ([method, op]) => [`${method.toUpperCase()} ${path}`, op] as const,
      ),
    ),
  );
const components = (doc: OpenApi) =>
  new Map<string, Item>(
    Object.entries<Item>(doc.components ?? {}).flatMap(([kind, items]) =>
      Object.entries<Item>(items).map(
        ([name, item]) => [`${kind}/${name}`, item] as const,
      ),
    ),
  );
const baseOf = (op: Item) =>
  BASES[Object.keys(op.security?.[0] ?? {})[0]] ?? 'no security';

/** Operation → every component it reaches through `$ref`s. */
function reach(doc: OpenApi): Map<string, Set<string>> {
  const all = components(doc);
  const out = new Map<string, Set<string>>();
  for (const [name, op] of operations(doc)) {
    const found = new Set<string>(
      (op.security ?? []).flatMap((s: Item) =>
        Object.keys(s).map((name) => `securitySchemes/${name}`),
      ),
    );
    const pending: unknown[] = [op];
    while (pending.length) {
      const value = pending.pop();
      if (typeof value !== 'object' || value === null) continue;
      const target =
        typeof (value as Item).$ref === 'string' &&
        (value as Item).$ref.replace('#/components/', '');
      if (target && !found.has(target)) {
        found.add(target);
        pending.push(all.get(target));
      }
      pending.push(...Object.values(value));
    }
    out.set(name, found);
  }
  return out;
}

/**
 * Renders the API contract section from the base and head documents.
 *
 * The contract builds every endpoint on one base (`authenticatedContract`,
 * recognized by the security scheme it attaches) and one
 * `authenticatedEndpoints(errors, tag)` group per tag. A
 * change that hits every endpoint of the base, or else of one or more
 * multi-endpoint tags, can only have been declared there or copied to each
 * endpoint, which is the same wire change, so it is reported once at that
 * origin. The base ref's source is never run: both sides are committed
 * documents, compared as they are.
 */
export function renderOpenApiDiff(before: OpenApi, after: OpenApi): string {
  const [oldOps, newOps] = [operations(before), operations(after)];
  const shared = [...newOps.keys()].filter((op) => oldOps.has(op));
  const byChange = new Map<string, { line: string; ops: string[] }>();
  for (const op of shared)
    for (const { line, key } of changes(oldOps.get(op)!, newOps.get(op)!))
      byChange.set(key, {
        line,
        ops: [...(byChange.get(key)?.ops ?? []), op],
      });

  /** `→ N endpoints`. */
  const reaching = (ops: string[]) =>
    ` → ${ops.length} endpoint${ops.length === 1 ? '' : 's'}`;
  const endpoint = code;
  /** The groups `ops` covers exactly, if any; a one-endpoint group is no origin. */
  const origins = (key: (op: string) => string) => {
    const groups = new Map<string, string[]>();
    for (const op of shared)
      groups.set(key(op), [...(groups.get(key(op)) ?? []), op]);
    return (ops: string[]) => {
      const set = new Set(ops);
      const touched = [...groups].filter(([, g]) =>
        g.some((op) => set.has(op)),
      );
      return touched.every(
        ([, g]) => g.length > 1 && g.every((op) => set.has(op)),
      )
        ? touched.map(([name]) => name)
        : undefined;
    };
  };
  const byBase = origins((op) => baseOf(newOps.get(op)!));
  const byTag = origins((op) => newOps.get(op)!.tags?.[0]);

  const out: string[] = [];
  const perEndpoint = new Map<string, string[]>();
  for (const { line, ops } of byChange.values()) {
    const origin =
      byBase(ops)?.map(code) ??
      byTag(ops)?.map((tag) => `${code(tag)} endpoints`);
    if (origin) out.push(`- ${origin.join(', ')}: ${line}${reaching(ops)}`);
    else
      for (const op of ops)
        perEndpoint.set(op, [...(perEndpoint.get(op) ?? []), line]);
  }
  for (const op of oldOps.keys())
    if (!newOps.has(op)) out.push(`- − endpoint ${endpoint(op)}`);
  for (const op of newOps.keys())
    if (!oldOps.has(op)) out.push(`- + endpoint ${endpoint(op)}`);

  for (const [op, lines] of perEndpoint)
    out.push(`- ${endpoint(op)}: ${lines.join('; ')}`);
  const [oldParts, newParts] = [components(before), components(after)];
  const [oldReach, newReach] = [reach(before), reach(after)];
  const users = (part: string) => [
    ...new Set(
      [...oldReach, ...newReach]
        .filter(([, found]) => found.has(part))
        .map(([op]) => op),
    ),
  ];
  for (const part of new Set([...oldParts.keys(), ...newParts.keys()])) {
    const [old, now] = [oldParts.get(part), newParts.get(part)];
    const lines = old && now ? changes(old, now).map((c) => c.line) : [];
    if (old && now && !lines.length) continue;
    const [kind, name] = part.split('/');
    const label = `${kind.replace(/s$/, '')} ${code(name)}`;
    out.push(
      `- ${lines.length ? `${label}: ${lines.join('; ')}` : `${old ? '−' : '+'} ${label}`}${reaching(users(part))}`,
    );
  }
  const other = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => !['paths', 'components'].includes(key))
    .filter((key) => json(before[key]) !== json(after[key]));
  if (other.length)
    out.push(`- other spec changes: ${other.map(code).join(', ')}`);

  if (!out.length) return '### API contract\n\nNo API contract change.';
  const shown = out.length > MAX_LINES ? out.slice(0, MAX_LINES - 1) : out;
  return [
    '### API contract',
    '',
    '`+` added · `−` removed · `~` changed',
    '',
    ...shown,
    ...(shown.length < out.length
      ? [
          `- +${out.length - shown.length} more; see the diff of the committed spec.`,
        ]
      : []),
  ].join('\n');
}
