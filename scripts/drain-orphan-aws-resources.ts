#!/usr/bin/env node
/**
 * Operator script: drain orphan AWS resources that production cleanup left
 * behind. Targets Security Groups tagged with anycloud_deployment.
 *
 * Why this exists: the account resource sweep tag-marks and tries to delete
 * orphanable resources, but failures (dependency violations, transient errors,
 * etc.) can still leave resources behind.
 *
 * Safety: dry-run by default. `--delete` actually deletes. Restricted to
 * anycloud-tagged resources only — never touches resources without the
 * anycloud_deployment tag.
 *
 * Usage:
 *   set -a; source .env; set +a
 *   npx tsx scripts/drain-orphan-aws-resources.ts                 # dry-run
 *   npx tsx scripts/drain-orphan-aws-resources.ts --delete        # do it
 */

import {
  EC2Client,
  DescribeRegionsCommand,
  DescribeSecurityGroupsCommand,
  DeleteSecurityGroupCommand,
} from '@aws-sdk/client-ec2';

interface Args {
  delete: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { delete: false };
  for (const a of argv) if (a === '--delete') args.delete = true;
  return args;
}

async function promptYes(question: string): Promise<boolean> {
  process.stdout.write(`${question} [y/N] `);
  return new Promise((resolve) => {
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (data) => {
      resolve(String(data).trim().toLowerCase() === 'y');
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    console.error('Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.');
    process.exit(1);
  }
  const credentials = {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  };

  const ec2 = new EC2Client({ credentials, region: 'us-east-1' });
  const regionsResp = await ec2.send(new DescribeRegionsCommand({}));
  const regions = (regionsResp.Regions ?? [])
    .map((r) => r.RegionName!)
    .filter(Boolean);
  console.log(
    `Mode: ${args.delete ? 'DELETE' : 'DRY-RUN'} across ${regions.length} regions\n`,
  );

  console.log('=== Security Groups (anycloud_deployment-tagged) ===');
  const sgCandidates: { region: string; id: string; name: string }[] = [];
  for (const region of regions) {
    const regionEc2 = new EC2Client({ credentials, region });
    const resp = await regionEc2.send(
      new DescribeSecurityGroupsCommand({
        Filters: [{ Name: 'tag-key', Values: ['anycloud_deployment'] }],
      }),
    );
    for (const sg of resp.SecurityGroups ?? []) {
      if (sg.GroupId && sg.GroupName) {
        sgCandidates.push({ region, id: sg.GroupId, name: sg.GroupName });
      }
    }
  }
  console.log(`  Candidates: ${sgCandidates.length}`);
  for (const c of sgCandidates)
    console.log(`    ${c.region}/${c.id} ${c.name}`);

  if (!args.delete) {
    console.log('\nDry-run only — re-run with --delete to actually drain.');
    return;
  }

  if (sgCandidates.length === 0) {
    console.log('\nNothing to delete.');
    return;
  }
  const confirmed = await promptYes(
    `\nReally delete ${sgCandidates.length} SG(s)?`,
  );
  if (!confirmed) {
    console.log('Aborted.');
    return;
  }

  let deleted = 0;
  let failed = 0;
  for (const c of sgCandidates) {
    const regionEc2 = new EC2Client({ credentials, region: c.region });
    try {
      await regionEc2.send(new DeleteSecurityGroupCommand({ GroupId: c.id }));
      console.log(`  deleted SG ${c.region}/${c.id}`);
      deleted++;
    } catch (error: any) {
      console.error(
        `  failed SG ${c.region}/${c.id}: ${error.Code ?? error.name ?? error.message}`,
      );
      failed++;
    }
  }
  console.log(`\nDone: deleted=${deleted}, failed=${failed}`);
}

main().catch((error) => {
  console.error('drain-orphan-aws-resources failed:', error);
  process.exit(1);
});
