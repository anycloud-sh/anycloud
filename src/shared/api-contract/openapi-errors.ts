import type { JSONSchema, OpenAPI, SchemaConverter } from '@orpc/openapi';
import { apiContractErrorDefinitions } from './inspection.js';
import { apiOpenApiSchemaName } from './openapi-schema-registry.js';

const UNDEFINED_ERROR_COMPONENT = 'UndefinedApiError';

function errorComponentName(code: string): string {
  const pascal = code
    .toLowerCase()
    .split('_')
    .map((part) => `${part[0]?.toUpperCase()}${part.slice(1)}`)
    .join('');
  return `${pascal}ApiError`;
}

export interface ApiErrorOpenApi {
  schemas: Record<string, OpenAPI.SchemaObject>;
  responseSchema: (
    definedErrors: [
      code: string,
      defaultMessage: string,
      dataRequired: boolean,
      dataSchema: JSONSchema,
    ][],
    status: number,
  ) => JSONSchema;
}

/** Derive named error components from the same error maps used by oRPC. */
export async function createApiErrorOpenApi(
  converter: SchemaConverter,
): Promise<ApiErrorOpenApi> {
  const definitions = apiContractErrorDefinitions();
  const schemas: Record<string, OpenAPI.SchemaObject> = {
    [UNDEFINED_ERROR_COMPONENT]: {
      type: 'object',
      additionalProperties: false,
      properties: {
        defined: { type: 'boolean', enum: [false] },
        code: { type: 'string' },
        status: { type: 'integer' },
        message: { type: 'string' },
        data: {},
      },
      required: ['defined', 'code', 'status', 'message'],
    },
  };

  for (const definition of definitions) {
    let dataRequired = false;
    let dataSchema: OpenAPI.SchemaObject | OpenAPI.ReferenceObject = {};
    if (definition.data) {
      const converted = await converter.convert(definition.data, {
        strategy: 'output',
      });
      dataRequired = converted[0];
      const registeredName = apiOpenApiSchemaName(definition.data);
      dataSchema = registeredName
        ? { $ref: `#/components/schemas/${registeredName}` }
        : (converted[1] as OpenAPI.SchemaObject);
    }

    const name = errorComponentName(definition.code);
    if (schemas[name]) {
      throw new Error(`Duplicate OpenAPI error component name: ${name}`);
    }
    schemas[name] = {
      type: 'object',
      additionalProperties: false,
      properties: {
        defined: { type: 'boolean', enum: [true] },
        code: { type: 'string', const: definition.code },
        status: { type: 'integer', const: definition.status },
        message: { type: 'string', default: definition.message },
        data: dataSchema,
      },
      required: [
        'defined',
        'code',
        'status',
        'message',
        ...(dataRequired ? ['data'] : []),
      ],
    };
  }

  return {
    schemas,
    responseSchema(definedErrors, status) {
      const codes = definedErrors.map(([code]) => code).sort();
      for (const code of codes) {
        const definition = definitions.find(
          (candidate) => candidate.code === code,
        );
        if (!definition || definition.status !== status) {
          throw new Error(
            `Missing OpenAPI error component for ${code}/${status}`,
          );
        }
      }
      return {
        oneOf: [
          ...codes.map((code) => ({
            $ref: `#/components/schemas/${errorComponentName(code)}`,
          })),
          { $ref: `#/components/schemas/${UNDEFINED_ERROR_COMPONENT}` },
        ],
        discriminator: {
          propertyName: 'code',
          mapping: Object.fromEntries(
            codes.map((code) => [
              code,
              `#/components/schemas/${errorComponentName(code)}`,
            ]),
          ),
        },
      };
    },
  };
}
