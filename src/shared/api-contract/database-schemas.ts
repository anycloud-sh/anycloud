import { z } from 'zod';

export const dbQueryInputSchema = z
  .object({
    sql: z.string().trim().min(1, 'sql is required'),
  })
  .strict();

export const dbQueryResponseSchema = z
  .object({
    rows: z.array(z.record(z.string(), z.unknown())),
    rowCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();

const dbColumnSchema = z
  .object({
    name: z.string().min(1),
    type: z.string(),
    notNull: z.literal(true).optional(),
    primaryKey: z.literal(true).optional(),
    defaultValue: z.string().optional(),
  })
  .strict();

const dbForeignKeySchema = z
  .object({
    column: z.string().min(1),
    references: z
      .object({ table: z.string().min(1), column: z.string().min(1) })
      .strict(),
    onDelete: z.string().optional(),
    onUpdate: z.string().optional(),
  })
  .strict();

const dbIndexSchema = z
  .object({
    name: z.string().min(1),
    unique: z.literal(true).optional(),
  })
  .strict();

const dbTableSchema = z
  .object({
    name: z.string().min(1),
    type: z.enum(['table', 'view']),
    columns: z.array(dbColumnSchema),
    foreignKeys: z.array(dbForeignKeySchema).optional(),
    indexes: z.array(dbIndexSchema).optional(),
  })
  .strict();

export const dbSchemaResponseSchema = z
  .object({ tables: z.array(dbTableSchema) })
  .strict();

export type DbQueryResponse = z.output<typeof dbQueryResponseSchema>;
export type DbSchemaResponse = z.output<typeof dbSchemaResponseSchema>;
