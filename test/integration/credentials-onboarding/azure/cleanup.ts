#!/usr/bin/env node

import {
  cleanupAzureOnboardingIdentity,
  cleanupAzureOnboardingRun,
  createBootstrapAzureContext,
  disposeBootstrapAzureContext,
  sweepAzureOnboardingIdentities,
  type AzureOnboardingIdentitySuite,
} from './admin.js';
import {
  authorizeAzureOnboardingRecovery,
  readAzureOnboardingRunLocator,
} from './run-authority.js';

function requiredSuite(): AzureOnboardingIdentitySuite {
  const suiteFlag = process.argv.indexOf('--suite');
  const suite = suiteFlag >= 0 ? process.argv[suiteFlag + 1] : undefined;
  if (suite !== 'onboarding' && suite !== 'bucket') {
    throw new Error('--suite must be either onboarding or bucket.');
  }
  return suite;
}

async function main(): Promise<void> {
  if (process.argv.includes('--run-recovery')) {
    if (process.argv.slice(2).length !== 1) {
      throw new Error(
        '--run-recovery cannot be combined with legacy cleanup selectors.',
      );
    }
    const locator = readAzureOnboardingRunLocator();
    // A known locator and Azure tags alone never establish abandonment.
    // Check GitHub before even logging into Azure.
    await authorizeAzureOnboardingRecovery(locator);
    const context = await createBootstrapAzureContext();
    const failures: unknown[] = [];
    try {
      await cleanupAzureOnboardingRun(context, locator);
    } catch (error) {
      failures.push(error);
    }
    try {
      await disposeBootstrapAzureContext(context);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) {
      throw new AggregateError(
        failures,
        'Azure abandoned run cleanup failed.',
        { cause: failures[0] },
      );
    }
    console.log(
      `Azure abandoned run cleanup complete: ${locator.operationId}.`,
    );
    return;
  }
  const suite = requiredSuite();
  const context = await createBootstrapAzureContext();
  try {
    const nameFlag = process.argv.indexOf('--display-name');
    const sweep = process.argv.includes('--sweep');
    if (nameFlag >= 0 && sweep) {
      throw new Error('Choose either --display-name or --sweep, not both.');
    }
    if (nameFlag >= 0) {
      const displayName = process.argv[nameFlag + 1];
      if (!displayName) {
        throw new Error('--display-name requires a service principal name.');
      }
      await cleanupAzureOnboardingIdentity(context, displayName, suite);
      console.log(
        `Azure onboarding identity cleanup complete: ${displayName}.`,
      );
      return;
    }
    if (!sweep) {
      throw new Error(
        'Pass --sweep to explicitly delete every owned identity in the selected suite.',
      );
    }
    const deletedIdentities = await sweepAzureOnboardingIdentities(
      context,
      suite,
    );
    console.log(
      `Azure ${suite} sweep complete: ${deletedIdentities} identity(s) deleted.`,
    );
  } finally {
    await disposeBootstrapAzureContext(context);
  }
}

function failureMessage(error: unknown): string {
  if (error instanceof AggregateError) {
    return `${error.message} ${error.errors.map(failureMessage).join('; ')}`;
  }
  return error instanceof Error ? error.message : String(error);
}

main().catch((error: unknown) => {
  console.error(`Azure onboarding cleanup failed: ${failureMessage(error)}`);
  process.exitCode = 1;
});
