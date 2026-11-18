import { expect, test } from 'vitest';

import {
  privateGitMarkers,
  privateGitPassed,
} from '../integration/e2e/internal/probes/private-git.js';

const cloned =
  'PRIVATE_GIT_TOKEN=present\nPRIVATE_GIT_LS_REMOTE=0\nPRIVATE_GIT_CLONE=0\nPRIVATE_GIT_FILE=AGENTS.md\n';
const refused =
  'PRIVATE_GIT_TOKEN=absent\nPRIVATE_GIT_LS_REMOTE=128\nPRIVATE_GIT_AUTH=refused\nPRIVATE_GIT_CLONE=128\n';

test('private Git passes only when the Secret decides the clone', () => {
  expect(privateGitPassed(privateGitMarkers(cloned), true)).toBe(true);
  expect(privateGitPassed(privateGitMarkers(refused), false)).toBe(true);
  // A token that reached the control, or a clone without the Secret's token.
  expect(privateGitPassed(privateGitMarkers(cloned), false)).toBe(false);
  expect(privateGitPassed(privateGitMarkers(refused), true)).toBe(false);
  // A control that failed for another reason, such as no network, proves nothing.
  expect(
    privateGitPassed(
      privateGitMarkers(refused.replace('PRIVATE_GIT_AUTH=refused\n', '')),
      false,
    ),
  ).toBe(false);
  // Git could not be installed: nothing ran.
  expect(
    privateGitPassed(
      privateGitMarkers(
        'PRIVATE_GIT_APK=failed\nPRIVATE_GIT_TOKEN=present\nPRIVATE_GIT_LS_REMOTE=127\nPRIVATE_GIT_CLONE=127\n',
      ),
      true,
    ),
  ).toBe(false);
});
