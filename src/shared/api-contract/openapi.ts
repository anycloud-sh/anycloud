import { OpenAPIGenerator } from '@orpc/openapi';
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4';
import { apiContract } from './contract.js';
import {
  CLIENT_VERSION_OPENAPI_PARAMETER,
  USER_OPENAPI_SECURITY_SCHEME,
} from './base.js';
import { apiOpenApiSchemas } from './openapi-schema-registry.js';
import { createApiErrorOpenApi } from './openapi-errors.js';

const zodSchemaConverter = new ZodToJsonSchemaConverter();

export interface ApiOpenApiDocumentOptions {
  version: string;
  title?: string;
}

type OpenApiLiteral = boolean | null | number | string;

const SCHEMA_ARRAY_KEYWORDS = new Set([
  'allOf',
  'anyOf',
  'oneOf',
  'prefixItems',
]);
const SCHEMA_KEYWORDS = new Set([
  'additionalItems',
  'additionalProperties',
  'contains',
  'contentSchema',
  'else',
  'if',
  'items',
  'not',
  'propertyNames',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
]);
const SCHEMA_MAP_KEYWORDS = new Set([
  '$defs',
  'definitions',
  'dependentSchemas',
  'patternProperties',
  'properties',
]);

function openApiLiteralType(
  literal: OpenApiLiteral,
): 'boolean' | 'integer' | 'null' | 'number' | 'string' {
  if (literal === null) return 'null';
  if (typeof literal === 'number') {
    return Number.isInteger(literal) ? 'integer' : 'number';
  }
  return typeof literal === 'boolean' ? 'boolean' : 'string';
}

function normalizeSchemaMap(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, schema]) => [
      key,
      normalizeOpenApiSchema(schema),
    ]),
  );
}

function normalizeReferenceSiblings(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const reference = schema.$ref;
  if (typeof reference !== 'string' || Object.keys(schema).length === 1) {
    return schema;
  }

  // OpenAPI Generator ignores a referenced parameter's type when `$ref` has
  // siblings such as `default`. A single-branch composition preserves the
  // JSON Schema intersection semantics while keeping the reference visible.
  const wrapper = (['anyOf', 'oneOf', 'allOf'] as const).find(
    (keyword) => !Object.prototype.hasOwnProperty.call(schema, keyword),
  );
  if (!wrapper) return schema;

  const { $ref: _reference, ...siblings } = schema;
  return {
    ...siblings,
    [wrapper]: [{ $ref: reference }],
  };
}

function normalizeOpenApiSchema(value: unknown): unknown {
  // JSON Schema permits boolean schemas, which must not be treated as literals.
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value;
  }

  const normalized: Record<string, unknown> = { ...value };
  for (const [key, child] of Object.entries(value)) {
    if (SCHEMA_MAP_KEYWORDS.has(key)) {
      normalized[key] = normalizeSchemaMap(child);
    } else if (SCHEMA_ARRAY_KEYWORDS.has(key) && Array.isArray(child)) {
      normalized[key] = child.map(normalizeOpenApiSchema);
    } else if (SCHEMA_KEYWORDS.has(key)) {
      normalized[key] = Array.isArray(child)
        ? child.map(normalizeOpenApiSchema)
        : normalizeOpenApiSchema(child);
    } else if (key === 'dependencies') {
      // Draft-07 dependencies can contain either schemas or property-name arrays.
      normalized[key] =
        typeof child === 'object' && child !== null && !Array.isArray(child)
          ? Object.fromEntries(
              Object.entries(child).map(([name, dependency]) => [
                name,
                Array.isArray(dependency)
                  ? dependency
                  : normalizeOpenApiSchema(dependency),
              ]),
            )
          : child;
    }
  }

  const literal = normalized.const;
  if (
    literal !== null &&
    typeof literal !== 'boolean' &&
    typeof literal !== 'number' &&
    typeof literal !== 'string'
  ) {
    return normalizeReferenceSiblings(normalized);
  }

  delete normalized.const;
  normalized.type = openApiLiteralType(literal);
  normalized.enum = [literal];
  return normalizeReferenceSiblings(normalized);
}

function normalizeOpenApiDocumentValue(
  value: unknown,
  path: readonly string[] = [],
): unknown {
  if (Array.isArray(value)) {
    return value.map((child) => normalizeOpenApiDocumentValue(child, path));
  }
  if (typeof value !== 'object' || value === null) return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      if (key === 'schemas' && path.at(-1) === 'components') {
        return [key, normalizeSchemaMap(child)];
      }
      if (key === 'schema') {
        return [key, normalizeOpenApiSchema(child)];
      }
      // These OpenAPI fields contain arbitrary JSON, not OpenAPI structures.
      if (
        key === 'default' ||
        key === 'example' ||
        key === 'examples' ||
        key.startsWith('x-')
      ) {
        return [key, child];
      }
      return [key, normalizeOpenApiDocumentValue(child, [...path, key])];
    }),
  );
}

/** Normalize OpenAPI schema locations for downstream generator compatibility. */
export function normalizeOpenApiSchemas<T>(document: T): T {
  return normalizeOpenApiDocumentValue(document) as T;
}

/** Generate the language-neutral artifact from the authored TypeScript contract. */
export async function generateApiOpenApiDocument(
  options: ApiOpenApiDocumentOptions,
) {
  const generator = new OpenAPIGenerator({
    schemaConverters: [zodSchemaConverter],
  });
  const errors = await createApiErrorOpenApi(zodSchemaConverter);
  return normalizeOpenApiSchemas(
    await generator.generate(apiContract, {
      info: {
        title: options.title ?? 'AnyCloud API',
        version: options.version,
      },
      // service-terminology-ok: OpenAPI names its base-URL collection `servers`
      servers: [{ url: 'http://localhost:8080/v1', description: 'Local API' }],
      commonSchemas: apiOpenApiSchemas(),
      customErrorResponseBodySchema: errors.responseSchema,
      components: {
        parameters: {
          [CLIENT_VERSION_OPENAPI_PARAMETER]: {
            name: 'AnyCloud-Client-Version',
            in: 'header',
            required: true,
            description:
              "The client's package version. Workload and credential read, quota status, cost and token operations accept this release's or the previous release's; the API upgrade operations and the token exchange also accept a newer one; every other operation needs this release's.",
            schema: { type: 'string' },
          },
        },
        securitySchemes: {
          [USER_OPENAPI_SECURITY_SCHEME]: {
            type: 'http',
            scheme: 'bearer',
            description: 'GitHub access token for the AnyCloud user.',
          },
        },
        schemas: errors.schemas,
      },
    }),
  );
}
