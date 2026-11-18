import { z } from 'zod';

/**
 * RFC 0049 C26 (d): what a lifecycle command deleted and what remains, each
 * resource in exactly one list. `cluster delete` defines the kinds below;
 * other lifecycle results add theirs to these unions.
 */

export const deletedResourceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('managementVm'),
      id: z.string().min(1),
      pending: z.literal(true).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('dnsRecord'),
      name: z.string().min(1),
      pending: z.literal(true).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('checkpointBucket'),
      name: z.string().min(1),
      /** Under `--no-wait`: `cluster status` reports when it finishes. */
      pending: z.literal(true).optional(),
    })
    .strict(),
]);

export const remainingResourceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('checkpointBucket'),
      name: z.string().min(1),
      managed: z.boolean(),
      /** `kept` by default; `supplied` buckets are never deleted. */
      reason: z.enum(['kept', 'supplied']),
      /** The newest backup's time; null when none could be read. */
      backedUpAt: z.string().min(1).nullable(),
      /** `skipped`: this delete took none (the record was already destroyed). */
      finalBackup: z.enum(['taken', 'failed', 'skipped']),
      error: z.string().min(1).optional(),
      restoreCommand: z.string().min(1),
      /** Only a managed bucket can be deleted with the installation. */
      deleteCommand: z.string().min(1).optional(),
    })
    .strict(),
]);

export type DeletedResource = z.output<typeof deletedResourceSchema>;
export type RemainingResource = z.output<typeof remainingResourceSchema>;
