#!/usr/bin/env node

import {
  cleanupAWSOnboardingUser,
  createBootstrapAWSContext,
  disposeBootstrapAWSContext,
  sweepAWSOnboardingUsers,
  type AWSOnboardingUserSuite,
} from './admin.js';

function requiredSuite(): AWSOnboardingUserSuite {
  const suiteFlag = process.argv.indexOf('--suite');
  const suite = suiteFlag >= 0 ? process.argv[suiteFlag + 1] : undefined;
  if (suite !== 'onboarding' && suite !== 'bucket') {
    throw new Error('--suite must be either onboarding or bucket.');
  }
  return suite;
}

async function main(): Promise<void> {
  const suite = requiredSuite();
  const context = await createBootstrapAWSContext();
  try {
    const userFlag = process.argv.indexOf('--user-name');
    const sweep = process.argv.includes('--sweep');
    if (userFlag >= 0 && sweep) {
      throw new Error('Choose either --user-name or --sweep, not both.');
    }
    if (userFlag >= 0) {
      const userName = process.argv[userFlag + 1];
      if (!userName) throw new Error('--user-name requires an IAM user name.');
      await cleanupAWSOnboardingUser(context, userName, suite);
      console.log(`AWS onboarding user cleanup complete: ${userName}.`);
      return;
    }
    if (!sweep) {
      throw new Error(
        'Pass --sweep to explicitly delete every owned identity in the selected suite.',
      );
    }
    const deletedUsers = await sweepAWSOnboardingUsers(context, suite);
    console.log(
      `AWS ${suite} sweep complete: ${deletedUsers} user(s) deleted.`,
    );
  } finally {
    await disposeBootstrapAWSContext(context);
  }
}

main().catch((error) => {
  console.error(
    `AWS onboarding sweep failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
