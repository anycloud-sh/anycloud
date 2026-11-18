// Preloaded into the API and CLI: answer the published GCP catalog's URL with
// the catalog this branch generated, which carries the N1 T4 rows.
import { readFileSync } from 'node:fs';

const csv = readFileSync(process.env.SPIKE_GCP_CATALOG, 'utf8');
const published = globalThis.fetch;
globalThis.fetch = (input, init) =>
  String(input instanceof Request ? input.url : input).includes('/gcp/vms.csv')
    ? Promise.resolve(new Response(csv))
    : published(input, init);
