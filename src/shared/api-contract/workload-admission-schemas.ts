import { z } from 'zod';
import { credentialNameSchema } from './credentials-schemas.js';
import { secretNameSchema } from './secrets-schemas.js';
import { CloudType, DiskTier } from '../cloud.js';
import {
  awsCredentialSchema,
  azureCredentialSchema,
  cloudCredentialSchema,
  gcpCredentialSchema,
  lambdaCredentialSchema,
} from './credentials-schemas.js';
import { dockerOptionsSchema } from './workload-management-schemas.js';

const requiredStringSchema = z.string().min(1);
const stringOrStringsSchema = z.union([
  requiredStringSchema,
  z.array(requiredStringSchema).min(1),
]);

const inlineCredentialSchema = z.union([
  awsCredentialSchema.extend({
    cloudProvider: z.literal(CloudType.AWS).optional(),
  }),
  gcpCredentialSchema.extend({
    cloudProvider: z.literal(CloudType.GCP).optional(),
  }),
  azureCredentialSchema.extend({
    cloudProvider: z.literal(CloudType.Azure).optional(),
  }),
  lambdaCredentialSchema.extend({
    cloudProvider: z.literal(CloudType.Lambda).optional(),
  }),
]);

const workloadCloudConfigSchema = z
  .object({
    region: z.string().optional(),
    vmType: stringOrStringsSchema.optional(),
    cloudProvider: z.enum(CloudType).optional(),
    credentials: inlineCredentialSchema.optional(),
    inputStorageCredentials: cloudCredentialSchema.optional(),
    inputStorageRegion: z.string().optional(),
    outputStorageCredentials: cloudCredentialSchema.optional(),
    outputStorageRegion: z.string().optional(),
    checkpointStorageCredentials: cloudCredentialSchema.optional(),
    checkpointStorageRegion: z.string().optional(),
    spot: z.boolean().optional(),
    inputBucket: z.string().optional(),
    outputBucket: z.string().optional(),
    checkpointBucket: z.string().optional(),
    diskSizeGb: z.number().positive().optional(),
    diskTier: z.enum(DiskTier).optional(),
    /** A VM Job on AWS: its gp3 root volume's IOPS, overriding the tier's. */
    diskIops: z.number().int().optional(),
    /** A VM Job on AWS: its gp3 root volume's throughput in MiB/s. */
    diskThroughputMibps: z.number().int().optional(),
    /** A VM Job: the regions it may launch in, instead of one `region`. */
    regions: z.array(z.string().trim().min(1)).min(1).optional(),
    availabilityZone: z.string().optional(),
    minVmCount: z.number().optional(),
    maxVmCount: z.number().optional(),
  })
  .strict()
  // As at credential save: a session credential expires, and minting the
  // bucket-scoped tokens VMs sync with needs a long-term IAM user key.
  .refine(
    ({ credentials }) => !(credentials && 'sessionToken' in credentials),
    {
      message:
        'Temporary AWS session credentials cannot be used because they expire. Use a long-lived IAM user access key.',
      path: ['credentials', 'sessionToken'],
    },
  );

const attributionSchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(z.string().max(64));

const jobMountSchema = z
  .object({
    /** `state`, the Job's own directory kept across attempts, or an absolute path on the substrate. */
    name: z.string().regex(/^(state|\/.*)$/),
    path: z.string().regex(/^\//),
    ro: z.boolean().optional(),
  })
  .strict();

/**
 * RFC 0046's neutral Job spec: the same meaning on every substrate. Each
 * substrate's admission refuses a value it can't run yet.
 */
const jobSpecFields = {
  nodes: z.number().int().positive().optional(),
  gpusPerNode: z.number().int().positive().optional(),
  launch: z.enum(['single', 'distributed']).optional(),
  mounts: z.array(jobMountSchema).optional(),
  /** Seconds one attempt may run. */
  timeLimit: z.number().int().positive().optional(),
  resumable: z.boolean().optional(),
};

/** Automatic retries after a disruption; a Job only. */
const maxRetriesSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER)
  .optional();

export const workloadAdmissionInputSchema = z
  .object({
    image: requiredStringSchema,
    cloudConfig: workloadCloudConfigSchema,
    gpuType: stringOrStringsSchema.optional(),
    id: z.string().trim().min(1).optional(),
    workloadType: z.enum(['job', 'service', 'vm']).optional(),
    maxRetries: maxRetriesSchema,
    /** A Job: no checkpoint storage, even on spot. */
    noCheckpoint: z.boolean().optional(),
    /** A VM Job: a VM type with nested virtualization (KVM), launched with it on. */
    requireNestedVirtualization: z.boolean().optional(),
    /** A VM Job: the host's Docker socket and, with KVM, `/dev/kvm`, instead of `--privileged`. */
    hostDocker: z.boolean().optional(),
    env: z.record(z.string(), z.string()).optional(),
    dockerOptions: dockerOptionsSchema.optional(),
    command: z.array(z.string()).optional(),
    credentialName: credentialNameSchema.optional(),
    inputStorageCredentialName: credentialNameSchema.optional(),
    outputStorageCredentialName: credentialNameSchema.optional(),
    checkpointStorageCredentialName: credentialNameSchema.optional(),
    secrets: z.array(secretNameSchema).optional(),
    session: attributionSchema.optional(),
    agent: attributionSchema.optional(),
    sessionLabel: attributionSchema.optional(),
    ...jobSpecFields,
  })
  .strict();

export const workloadAdmissionResponseSchema = z
  .object({
    id: z.string().min(1),
    url: z.string().optional(),
  })
  .strict();

export type WorkloadAdmissionInput = z.output<
  typeof workloadAdmissionInputSchema
>;
export type JobSpecInput = Pick<
  WorkloadAdmissionInput,
  keyof typeof jobSpecFields
>;
export type WorkloadAdmissionCloudConfig =
  WorkloadAdmissionInput['cloudConfig'];
export type WorkloadAdmissionResponse = z.output<
  typeof workloadAdmissionResponseSchema
>;
