import { sweepDnsRecords } from '../../test/integration/e2e/internal/substrates/cloud-cluster/dns-records.js';

/**
 * `npx tsx ci/cleanup/e2e-cluster-dns-records.ts <id>[,<id>…] …` with `GITHUB_TOKEN`
 * (the account that published the records): deletes `<id>.anycloud.sh` at the
 * DNS Worker for every installation id given, prints each outcome, exits 1 on
 * a failure. A 2xx (`cleared`) is idempotent and does not say a record existed.
 */
const token = process.env.GITHUB_TOKEN;
if (!token) throw new Error('GITHUB_TOKEN is required to delete DNS records');
const ids = process.argv
  .slice(2)
  .flatMap((arg) => arg.split(/[\s,]+/))
  .filter(Boolean);
for (const { subdomain, outcome, reason } of await sweepDnsRecords(ids, {
  token,
})) {
  const line = `dns record ${subdomain}.anycloud.sh: ${outcome}`;
  if (outcome !== 'failed') console.log(line);
  else {
    process.exitCode = 1;
    console.error(`::error::${line} (${reason})`);
  }
}
