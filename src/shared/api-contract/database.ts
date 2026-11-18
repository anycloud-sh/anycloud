import { z } from 'zod';
import { authenticatedEndpoints } from './base.js';
import {
  dbQueryInputSchema,
  dbQueryResponseSchema,
  dbSchemaResponseSchema,
} from './database-schemas.js';

const authenticated = authenticatedEndpoints({}, 'Database');

const schemaRequestSchema = z.object({
  query: z
    .object({
      table: z.string().optional(),
    })
    .strict(),
});

// SQL is carried in a POST body, but this endpoint permits reads only. Declare
// that semantic exception explicitly so method-derived replay remains honest.
const query = authenticated
  .query(
    {
      method: 'POST',
      path: '/database/queries',
      operationId: 'queryDatabase',
      summary: 'Run a read-only SQL query',
    },
    { replay: 'safe', timeoutMs: 60_000 },
  )
  .input(dbQueryInputSchema)
  .output(dbQueryResponseSchema)
  .errors({
    DB_QUERY_INVALID: {
      status: 400,
      message: 'Invalid database query',
    },
  });

const schema = authenticated
  .query({
    method: 'GET',
    path: '/database/schema',
    operationId: 'getDatabaseSchema',
    summary: 'Inspect the database schema',
    inputStructure: 'detailed',
  })
  .input(schemaRequestSchema)
  .output(dbSchemaResponseSchema);

export const databaseContract = { query, schema };
