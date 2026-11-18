import { z } from 'zod';
import { seedTestWorkload } from '../../helpers/workload-store.js';
import { WorkloadState } from '../../../src/shared/workload.js';

const seedInputSchema = z
  .object({
    id: z.string().min(1),
    userId: z.string().min(1),
    ownerUserId: z.string().min(1).optional(),
    state: z.enum(WorkloadState).optional(),
    image: z.string().min(1).optional(),
  })
  .strict();

/** Seeds one workload from JSON on stdin for shell integration tests. */
async function main(): Promise<void> {
  process.stdin.setEncoding('utf8');
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  await seedTestWorkload(seedInputSchema.parse(JSON.parse(input)));
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
