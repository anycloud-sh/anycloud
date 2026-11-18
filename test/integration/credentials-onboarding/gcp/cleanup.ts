#!/usr/bin/env node

import {
  cleanupGCPOnboardingAccount,
  createBootstrapGcloudContext,
  disposeBootstrapGcloudContext,
  sweepGCPOnboardingAccounts,
  type GCPOnboardingAccountSuite,
} from './admin.js';

function requiredSuite(): GCPOnboardingAccountSuite {
  const suiteFlag = process.argv.indexOf('--suite');
  const suite = suiteFlag >= 0 ? process.argv[suiteFlag + 1] : undefined;
  if (suite !== 'onboarding' && suite !== 'bucket') {
    throw new Error('--suite must be either onboarding or bucket.');
  }
  return suite;
}

async function main(): Promise<void> {
  const suite = requiredSuite();
  const context = await createBootstrapGcloudContext();
  try {
    const emailFlag = process.argv.indexOf('--email');
    const sweep = process.argv.includes('--sweep');
    if (emailFlag >= 0 && sweep) {
      throw new Error('Choose either --email or --sweep, not both.');
    }
    if (emailFlag >= 0) {
      const email = process.argv[emailFlag + 1];
      if (!email) throw new Error('--email requires a service-account email.');
      await cleanupGCPOnboardingAccount(context, email, suite);
      console.log(`GCP onboarding account cleanup complete: ${email}.`);
      return;
    }

    if (!sweep) {
      throw new Error(
        'Pass --sweep to explicitly delete every owned identity in the selected suite.',
      );
    }

    const deletedAccounts = await sweepGCPOnboardingAccounts(context, suite);
    console.log(
      `GCP ${suite} sweep complete: ${deletedAccounts} account(s) deleted.`,
    );
  } finally {
    await disposeBootstrapGcloudContext(context);
  }
}

main().catch((error) => {
  console.error(
    `GCP onboarding sweep failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
