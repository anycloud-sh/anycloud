import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { WIZARD_JOURNEYS } from '../../integration/credentials-onboarding/journeys.js';

const evidenceFiles = [
  'test/integration/credentials-onboarding/common/terminal.spec.ts',
  'test/integration/credentials-onboarding/aws/terminal.spec.ts',
  'test/integration/credentials-onboarding/azure/terminal.spec.ts',
  'test/integration/credentials-onboarding/gcp/terminal.spec.ts',
  'test/integration/credentials-onboarding/aws/live.spec.ts',
  'test/integration/credentials-onboarding/azure/live.spec.ts',
  'test/integration/credentials-onboarding/gcp/live.spec.ts',
  'test/integration/credentials-onboarding/installed/terminal.spec.ts',
  '.github/workflows/release.yml',
  'docs/release-browser-auth-checklist.md',
];

describe('credential wizard journey matrix', () => {
  it('maps every declared journey to executable or documented evidence', () => {
    const evidence = evidenceFiles
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n');

    for (const journey of WIZARD_JOURNEYS) {
      expect(evidence, `Missing evidence for ${journey.id}`).toContain(
        journey.id,
      );
    }
  });

  it('uses unique stable journey IDs', () => {
    const ids = WIZARD_JOURNEYS.map((journey) => journey.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
