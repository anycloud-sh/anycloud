import { writeFileSync } from 'node:fs';

const output = process.env.SPIKE_CHILD_OUTPUT;
if (!output) throw new Error('SPIKE_CHILD_OUTPUT is required');
writeFileSync(output, JSON.stringify(process.argv.slice(2)));
process.exitCode = Number(process.env.SPIKE_CHILD_EXIT_CODE ?? '0');
