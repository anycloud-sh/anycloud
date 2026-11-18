export type WizardJourneyTier = 'pr' | 'live' | 'release' | 'manual';
export type WizardJourneyProvider =
  | 'common'
  | 'aws'
  | 'azure'
  | 'gcp'
  | 'lambda';

export interface WizardJourney {
  id: string;
  provider: WizardJourneyProvider;
  tier: WizardJourneyTier;
  contract: string;
}

/**
 * Executable inventory for the human-facing credential wizard. Specs use the
 * IDs in their titles, so adding a contract here without a matching test is
 * visible in test reports and review.
 */
export const WIZARD_JOURNEYS = [
  {
    id: 'common.prompt-order',
    provider: 'common',
    tier: 'pr',
    contract: 'Bare command asks for name, then lists providers in UX order.',
  },
  {
    id: 'common.name-validation',
    provider: 'common',
    tier: 'pr',
    contract: 'An empty name is rejected without advancing the wizard.',
  },
  {
    id: 'common.duplicate-name',
    provider: 'common',
    tier: 'pr',
    contract: 'A duplicate name fails before any provider CLI mutation.',
  },
  {
    id: 'common.cancel-name',
    provider: 'common',
    tier: 'pr',
    contract: 'Ctrl-C at name entry exits zero without persistence.',
  },
  {
    id: 'common.cancel-provider',
    provider: 'common',
    tier: 'pr',
    contract: 'Ctrl-C at provider selection exits zero without persistence.',
  },
  {
    id: 'common.cancel-manual-entry',
    provider: 'common',
    tier: 'pr',
    contract:
      'Every provider manual-entry field accepts Ctrl-C without persistence.',
  },
  {
    id: 'common.fresh-manual-import',
    provider: 'common',
    tier: 'pr',
    contract:
      'Manual entry uses fresh values even when complete environment credentials are available.',
  },
  {
    id: 'common.import-consent',
    provider: 'common',
    tier: 'pr',
    contract:
      'Every provider reviews a selected import and defaults to saving; approval, default Yes, No, and Ctrl-C preserve secret masking.',
  },
  {
    id: 'common.cancel-import-source',
    provider: 'common',
    tier: 'pr',
    contract:
      'Canceling a detected credential source exits successfully without saving.',
  },
  {
    id: 'common.noninteractive-import',
    provider: 'common',
    tier: 'pr',
    contract: 'Noninteractive environment imports remain prompt-free.',
  },
  {
    id: 'common.save-rejected',
    provider: 'common',
    tier: 'pr',
    contract:
      'An API rejection is shown without persisting or echoing an imported secret.',
  },
  {
    id: 'common.save-response-lost',
    provider: 'common',
    tier: 'pr',
    contract:
      'A lost response after commit is reconciled without deleting an Azure identity.',
  },
  {
    id: 'common.admin-handoff',
    provider: 'common',
    tier: 'pr',
    contract:
      'Without credentials or provider CLIs, AWS, Azure, and GCP offer manual entry and an administrator request that saves nothing.',
  },
  {
    id: 'common.missing-cli-hint',
    provider: 'common',
    tier: 'pr',
    contract:
      'Choosing Azure or GCP generation without its CLI prints a sudo-free install hint.',
  },
  {
    id: 'aws.generation-target-required',
    provider: 'aws',
    tier: 'pr',
    contract:
      'AWS generation requires an explicit operator profile and target account before provider access.',
  },
  {
    id: 'aws.live-generation',
    provider: 'aws',
    tier: 'live',
    contract:
      'Explicit AWS generation saves, immediately uses, and cleans up the exact owned IAM identity.',
  },
  {
    id: 'aws.non-importable-profile',
    provider: 'aws',
    tier: 'pr',
    contract:
      'An SSO or other dynamic profile is rejected with durable-import guidance.',
  },
  {
    id: 'aws.static-profile-import',
    provider: 'aws',
    tier: 'pr',
    contract:
      'The source picker authenticates selected durable static keys and confirms before saving without IAM mutation.',
  },
  {
    id: 'aws.import-review',
    provider: 'aws',
    tier: 'pr',
    contract:
      'A sole profile requires selection and review of its authenticated identity before saving.',
  },
  {
    id: 'aws.cancel-import',
    provider: 'aws',
    tier: 'pr',
    contract:
      'No and Ctrl-C at import confirmation exit successfully without saving.',
  },
  {
    id: 'aws.environment-selection',
    provider: 'aws',
    tier: 'pr',
    contract:
      'Environment keys are a default choice, and selecting either them or a profile requires confirmation before saving.',
  },
  {
    id: 'aws.manual-keys',
    provider: 'aws',
    tier: 'pr',
    contract: 'Missing AWS profiles fall back to masked manual key entry.',
  },
  {
    id: 'aws.rejected-import',
    provider: 'aws',
    tier: 'pr',
    contract:
      'A well-formed but rejected AWS key fails import without saving or echoing the secret.',
  },
  {
    id: 'aws.missing-cli-hint',
    provider: 'aws',
    tier: 'pr',
    contract:
      'Without the AWS CLI, a sudo-free install hint is printed even when profiles exist, and the picker keeps import, manual entry, and the administrator request.',
  },
  {
    id: 'aws.generation-permission-denied',
    provider: 'aws',
    tier: 'pr',
    contract:
      'An AccessDenied during generation prints an administrator request naming the operator identity.',
  },
  {
    id: 'azure.enter-existing',
    provider: 'azure',
    tier: 'pr',
    contract:
      'Azure onboarding explicitly offers entry of an existing service principal.',
  },
  {
    id: 'azure.explicit-generation',
    provider: 'azure',
    tier: 'pr',
    contract:
      'Azure onboarding creates a principal only after the user selects generation.',
  },
  {
    id: 'azure.permission-preview',
    provider: 'azure',
    tier: 'pr',
    contract:
      'Generation shows tenant, subscription, scope, and roles before confirmation.',
  },
  {
    id: 'azure.cancel-generation',
    provider: 'azure',
    tier: 'pr',
    contract:
      'Declining generation exits without provider mutation or persistence.',
  },
  {
    id: 'azure.browser-login',
    provider: 'azure',
    tier: 'pr',
    contract: 'Explicit generation can launch Azure CLI login and resume.',
  },
  {
    id: 'azure.multiple-subscriptions',
    provider: 'azure',
    tier: 'pr',
    contract: 'Subscription selection previews and uses the selected target.',
  },
  {
    id: 'azure.permission-failure',
    provider: 'azure',
    tier: 'pr',
    contract:
      'A generation permission failure is visible and never changes acquisition modes.',
  },
  {
    id: 'azure.identity-collision',
    provider: 'azure',
    tier: 'pr',
    contract:
      'An observed orphaned Entra service principal blocks a colliding name before mutation.',
  },
  {
    id: 'gcp.generation-target-required',
    provider: 'gcp',
    tier: 'pr',
    contract:
      'GCP generation requires an explicit operator account and project before provider access.',
  },
  {
    id: 'gcp.discovered-key',
    provider: 'gcp',
    tier: 'pr',
    contract: 'A discovered service-account key can be imported.',
  },
  {
    id: 'gcp.upload-key',
    provider: 'gcp',
    tier: 'pr',
    contract:
      'A service-account JSON import persists only the reviewed key after approval, even if its source changes.',
  },
  {
    id: 'gcp.cancel-upload',
    provider: 'gcp',
    tier: 'pr',
    contract:
      'Declining a GCP upload leaves no saved credential or local key copy.',
  },
  {
    id: 'gcp.malformed-key',
    provider: 'gcp',
    tier: 'pr',
    contract:
      'A malformed service-account key file is rejected without saving.',
  },
  {
    id: 'lambda.manual-key',
    provider: 'lambda',
    tier: 'pr',
    contract: 'Bare wizard persists a masked Lambda Labs API key.',
  },
  {
    id: 'aws.live-import',
    provider: 'aws',
    tier: 'live',
    contract:
      'A test-owned static profile is imported, used through the API, and cleaned up.',
  },
  {
    id: 'azure.live-generation',
    provider: 'azure',
    tier: 'live',
    contract:
      'Explicit Azure generation saves, immediately uses, and cleans up the owned principal.',
  },
  {
    id: 'azure.live-manual',
    provider: 'azure',
    tier: 'live',
    contract:
      'A test-owned Azure principal is entered, used through the API, and cleaned up.',
  },
  {
    id: 'gcp.live-generation',
    provider: 'gcp',
    tier: 'live',
    contract:
      'Explicit GCP generation saves, immediately uses, and cleans up the exact owned service-account key.',
  },
  {
    id: 'gcp.live-import',
    provider: 'gcp',
    tier: 'live',
    contract:
      'A test-owned service-account JSON key is imported, used through the API, and cleaned up.',
  },
  {
    id: 'common.installed-artifact',
    provider: 'common',
    tier: 'release',
    contract: 'Installer-produced binary passes the same bare wizard contract.',
  },
  {
    id: 'aws.installed-generation-target-required',
    provider: 'aws',
    tier: 'release',
    contract:
      'Installer-produced binary requires an explicit AWS operator and account before generation.',
  },
  {
    id: 'gcp.installed-generation-target-required',
    provider: 'gcp',
    tier: 'release',
    contract:
      'Installer-produced binary requires a GCP operator account and project before generation.',
  },
  {
    id: 'common.published-canary',
    provider: 'common',
    tier: 'release',
    contract:
      'Published installer returns the exact release and completes a canary.',
  },
  {
    id: 'common.browser-consent',
    provider: 'common',
    tier: 'manual',
    contract:
      'Fresh macOS and Linux sessions complete real browser consent and MFA.',
  },
] satisfies WizardJourney[];

const JOURNEYS_BY_ID = new Map(
  WIZARD_JOURNEYS.map((journey) => [journey.id, journey]),
);

export function journeyTitle(id: string): string {
  const journey = JOURNEYS_BY_ID.get(id);
  if (!journey) throw new Error(`Unknown wizard journey: ${id}`);
  return `[${journey.id}] ${journey.contract}`;
}
