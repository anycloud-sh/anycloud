import { describe, expect, test } from 'vitest';

import {
  formatRollup,
  parseEnforcementLedger,
  parseLegacySourceDisposition,
  validateClassTableScope,
  validateEnforcementLedger,
  validateEnforcementRollup,
  validateLegacySourceDisposition,
  validateMembershipMatrices,
  validateScenarioCoverage,
} from '../../../scripts/validate-rfc-ledgers.mjs';

const dispositionHeader = `## Legacy source disposition

| Legacy source | Owner | Disposition | Replacement or destination | Notes |
| --- | --- | --- | --- | --- |`;

const dispositionRow = (
  source = 'test/integration/aws-vm.test.sh',
  disposition = 'Replace',
): string =>
  `| \`${source}\` | Persistent VM | ${disposition} | VM contracts | Both members qualify. |`;

describe('RFC 0017 legacy source disposition', () => {
  test('parses and accepts one exact registered source', () => {
    const markdown = `${dispositionHeader}\n${dispositionRow()}\n`;
    expect(parseLegacySourceDisposition(markdown)).toEqual([
      {
        source: 'test/integration/aws-vm.test.sh',
        owner: 'Persistent VM',
        disposition: 'Replace',
        replacement: 'VM contracts',
        notes: 'Both members qualify.',
      },
    ]);
    expect(
      validateLegacySourceDisposition(markdown, {
        registeredSources: ['test/integration/aws-vm.test.sh'],
        expectedDispositions: new Map([
          ['test/integration/aws-vm.test.sh', 'Replace'],
        ]),
      }),
    ).toEqual([]);
  });

  test('rejects missing, duplicate, unregistered, and misclassified sources', () => {
    const registered = [
      'test/integration/aws-vm.test.sh',
      'test/integration/azure-vm.test.sh',
    ];
    const errors = validateLegacySourceDisposition(
      `${dispositionHeader}\n${dispositionRow()}\n${dispositionRow()}\n${dispositionRow(
        'test/integration/unknown.test.sh',
        'Maybe',
      )}\n`,
      {
        registeredSources: registered,
        expectedDispositions: new Map([
          ['test/integration/aws-vm.test.sh', 'Retain'],
        ]),
      },
    );
    expect(errors).toContain(
      'duplicate legacy source disposition: test/integration/aws-vm.test.sh',
    );
    expect(errors).toContain(
      'unregistered legacy source disposition: test/integration/unknown.test.sh',
    );
    expect(errors).toContain(
      'invalid disposition for test/integration/unknown.test.sh: Maybe',
    );
    expect(errors).toContain(
      'test/integration/aws-vm.test.sh is registered as Retain, found Replace',
    );
    expect(errors).toContain(
      'missing legacy source disposition: test/integration/azure-vm.test.sh',
    );
  });

  test('rejects duplicate owner registrations before collapsing them to a set', () => {
    expect(
      validateLegacySourceDisposition(
        `${dispositionHeader}\n${dispositionRow()}\n`,
        {
          registeredSources: [
            'test/integration/aws-vm.test.sh',
            'test/integration/aws-vm.test.sh',
          ],
        },
      ),
    ).toContain(
      'legacy source registered more than once: test/integration/aws-vm.test.sh',
    );
  });
});

const invariants = (annotation: string, rule = 'Shared behavior.'): string =>
  `## Core invariants\n\n1. ${rule}\n    _Enforcement: ${annotation}_\n\n## Goals\n`;

function enforcementInventory(
  overrides: {
    graphRules?: Set<string>;
    lintRules?: Set<string>;
    paths?: Set<string>;
    policyScripts?: Set<string>;
    wiredGraphRules?: Set<string>;
    wiredLintRules?: Set<string>;
    wiredPolicyScripts?: Set<string>;
  } = {},
) {
  return {
    graphRules: new Set([
      'cloud-resource-boundary',
      'module-ownership:credential-onboarding.acquisition.ts',
    ]),
    lintRules: new Set(['valid-e2e-contract-spec']),
    paths: new Set(['internal/workloads.ts']),
    wiredGraphRules: new Set([
      'cloud-resource-boundary',
      'module-ownership:credential-onboarding.acquisition.ts',
    ]),
    wiredLintRules: new Set(['valid-e2e-contract-spec']),
    ...overrides,
  };
}

describe('RFC 0017 enforcement ledger validation', () => {
  test.each([
    'type — the branded reference in `internal/workloads.ts`.',
    'lint:valid-e2e-contract-spec — member specs are closed.',
    'graph:cloud-resource-boundary — gateways stay off cluster modules.',
    'graph:module-ownership:credential-onboarding.acquisition.ts — owned.',
    'runtime — the fixture aggregates cleanup failures.',
    'test — a unit spec covers it.',
    'review — nothing mechanises this yet.',
  ])('accepts %s', (annotation) => {
    expect(
      validateEnforcementLedger(invariants(annotation), enforcementInventory()),
    ).toEqual([]);
  });

  test('requires every invariant to declare an enforcement layer', () => {
    expect(
      validateEnforcementLedger(
        '## Core invariants\n\n1. Shared behavior.\n\n## Goals\n',
        enforcementInventory(),
      ),
    ).toEqual(['core invariant 1 has no enforcement annotation']);
  });

  test('rejects an unknown layer', () => {
    expect(
      validateEnforcementLedger(
        invariants('vibes — it feels enforced.'),
        enforcementInventory(),
      ),
    ).toEqual(['core invariant 1 names an unknown enforcement layer: vibes']);
  });

  // The point of the ledger: a rule cannot claim enforcement that was never
  // wired, whether the rule is missing outright or merely absent from the
  // ESLint configuration.
  test('rejects a lint rule that does not exist', () => {
    expect(
      validateEnforcementLedger(
        invariants('lint:no-such-rule — claims a rule.'),
        enforcementInventory(),
      ),
    ).toEqual([
      'core invariant 1 names a lint rule that does not exist: no-such-rule',
    ]);
  });

  test('validates secondary mechanism references in the explanation', () => {
    expect(
      validateEnforcementLedger(
        invariants(
          'graph:cloud-resource-boundary — held with its runner (graph:no-such-rule).',
        ),
        enforcementInventory(),
      ),
    ).toEqual([
      'core invariant 1 references a graph mechanism that does not exist: no-such-rule',
    ]);
  });

  test('accepts a valid secondary mechanism reference', () => {
    expect(
      validateEnforcementLedger(
        invariants(
          'graph:cloud-resource-boundary — held with lint:valid-e2e-contract-spec too.',
        ),
        enforcementInventory(),
      ),
    ).toEqual([]);
  });

  test('rejects a graph rule that does not exist', () => {
    expect(
      validateEnforcementLedger(
        invariants('graph:no-such-rule — claims a rule.'),
        enforcementInventory(),
      ),
    ).toEqual([
      'core invariant 1 names a graph rule that does not exist: no-such-rule',
    ]);
  });

  test('rejects a graph rule that exists but is not wired', () => {
    expect(
      validateEnforcementLedger(
        invariants('graph:cloud-resource-boundary — off.'),
        enforcementInventory({ wiredGraphRules: new Set() }),
      ),
    ).toEqual([
      'core invariant 1 names a graph rule that is not wired: cloud-resource-boundary',
    ]);
  });

  test('rejects a lint rule that exists but is not wired', () => {
    expect(
      validateEnforcementLedger(
        invariants('lint:valid-e2e-contract-spec — closed.'),
        enforcementInventory({ wiredLintRules: new Set() }),
      ),
    ).toEqual([
      'core invariant 1 names a lint rule that is not wired: valid-e2e-contract-spec',
    ]);
  });

  test('rejects a mechanism file that does not exist', () => {
    expect(
      validateEnforcementLedger(
        invariants('type — the kernel in `internal/gone.ts`.'),
        enforcementInventory(),
      ),
    ).toEqual(['core invariant 1 names a missing file: internal/gone.ts']);
  });

  test('requires review to say why', () => {
    expect(
      validateEnforcementLedger(invariants('review'), enforcementInventory()),
    ).toEqual(['core invariant 1 does not explain its review enforcement']);
  });

  // `script:` gets the same exists-and-wired standard as `lint:` — a boundary
  // script that exists but is invoked by no package.json check script enforces
  // nothing.
  test('accepts a policy script that exists and is wired', () => {
    expect(
      validateEnforcementLedger(
        invariants(
          'script:scripts/check-example.mjs — the boundary chain rejects it.',
        ),
        enforcementInventory({
          policyScripts: new Set(['scripts/check-example.mjs']),
          wiredPolicyScripts: new Set(['scripts/check-example.mjs']),
        }),
      ),
    ).toEqual([]);
  });

  test('rejects a policy script that does not exist', () => {
    expect(
      validateEnforcementLedger(
        invariants('script:scripts/check-example.mjs — claims a script.'),
        enforcementInventory(),
      ),
    ).toEqual([
      'core invariant 1 names a policy script that does not exist: scripts/check-example.mjs',
    ]);
  });

  test('rejects a policy script that is not wired', () => {
    expect(
      validateEnforcementLedger(
        invariants('script:scripts/check-example.mjs — claims a script.'),
        enforcementInventory({
          policyScripts: new Set(['scripts/check-example.mjs']),
        }),
      ),
    ).toEqual([
      'core invariant 1 names a policy script that is not wired: scripts/check-example.mjs',
    ]);
  });

  // RFC 0015 uses `## Required invariants`; the heading and entry label are
  // document facts, not constants of the ledger.
  test('reads a differently headed section and labels its entries', () => {
    const markdown =
      '## Required invariants\n\n1. Shared behavior.\n\n## Goals\n';
    const options = {
      entryLabel: 'required invariant',
      heading: 'Required invariants',
    };

    expect(parseEnforcementLedger(markdown, options)).toEqual([
      { annotation: undefined, number: 1 },
    ]);
    expect(
      validateEnforcementLedger(markdown, enforcementInventory(), options),
    ).toEqual(['required invariant 1 has no enforcement annotation']);
  });

  // Annotations wrap like any other prose; the parser joins the wrapped lines
  // back into one annotation.
  test('reads an annotation that wraps across lines', () => {
    const markdown = [
      '## Core invariants',
      '',
      '1. Shared behavior.',
      '   _Enforcement: type — the branded reference in',
      '   `internal/workloads.ts`._',
      '',
      '## Goals',
      '',
    ].join('\n');

    expect(parseEnforcementLedger(markdown)).toEqual([
      {
        annotation: 'type — the branded reference in `internal/workloads.ts`.',
        number: 1,
      },
    ]);
  });
});

const annotated = [
  '## Core invariants',
  '',
  '1. Shared behavior.',
  '   _Enforcement: lint:valid-e2e-contract-spec — members are closed._',
  '2. Tracked references.',
  '   _Enforcement: type — the branded reference._',
  '3. Consumer counting.',
  '   _Enforcement: review — no check counts consumers._',
  '',
  '## Goals',
  '',
].join('\n');

describe('enforcement rollup', () => {
  // The rollup separates what the validator proved from what it only cited, so
  // the weaker claim cannot borrow the stronger one's credibility.
  test('formats wired, cited, and review counts with the review list', () => {
    expect(formatRollup(parseEnforcementLedger(annotated))).toBe(
      '**1 of 3 verified wired, 1 cited, and 1 resting on review**: invariant 3.',
    );
  });

  test('requires the document to carry the computed rollup verbatim', () => {
    expect(validateEnforcementRollup(annotated)).toEqual([
      'rollup sentence must read: **1 of 3 verified wired, 1 cited, and 1 resting on review**: invariant 3.',
    ]);
  });

  test('accepts the rollup wherever it appears, however wrapped', () => {
    const markdown = `${annotated}\nOn 2026-08-26 that is **1 of 3 verified wired, 1 cited, and 1 resting\non review**: invariant 3.\n`;

    expect(validateEnforcementRollup(markdown)).toEqual([]);
  });

  test('rejects a drifted count', () => {
    const markdown = `${annotated}\n**2 of 3 verified wired, 0 cited, and 1 resting on review**: invariant 3.\n`;

    expect(validateEnforcementRollup(markdown)).toEqual([
      'rollup sentence must read: **1 of 3 verified wired, 1 cited, and 1 resting on review**: invariant 3.',
    ]);
  });
});

const matrix = (cell: string): string =>
  [
    '| Serve concern | Kind | AWS | Vast |',
    '| --- | --- | --- | --- |',
    `| Public ingress | Fixed baseline observation | Required | ${cell} |`,
    '',
  ].join('\n');

describe('RFC 0017 membership matrix validation', () => {
  test('accepts a declared exclusion that gives its reason', () => {
    expect(
      validateMembershipMatrices(
        matrix('Unsupported — baseline Serve is unsupported'),
        new Map([['serve', new Set(['aws'])]]),
      ),
    ).toEqual([]);
  });

  // Invariant 6: a target with no coverage must read as a decision, so an
  // exclusion without a reason is indistinguishable from an oversight.
  test('rejects an exclusion with no reason', () => {
    expect(
      validateMembershipMatrices(matrix('Unsupported'), new Map()),
    ).toEqual([
      'Serve membership marks Vast / Public ingress Unsupported without a reason',
    ]);
  });

  test('rejects a value outside the closed vocabulary', () => {
    expect(
      validateMembershipMatrices(matrix('Maybe later'), new Map()),
    ).toEqual([
      'Serve membership for Vast / Public ingress is not Required, Unsupported, or Evaluate: Maybe later',
    ]);
  });

  // The dangerous direction: a member ships while the matrix says the target
  // is excluded, so the document and the suite disagree about coverage.
  test('rejects a shipped member the matrix declares unsupported', () => {
    expect(
      validateMembershipMatrices(
        matrix('Unsupported — baseline Serve is unsupported'),
        new Map([['serve', new Set(['aws', 'vast'])]]),
      ),
    ).toEqual([
      'Serve has a vast member while the matrix marks it unsupported for Public ingress',
    ]);
  });
});

describe('RFC 0017 class-table scope validation', () => {
  const contracts = [
    { family: 'persistent-vm', name: 'aws-vm' },
    { family: 'persistent-vm', name: 'azure-vm' },
    { family: 'serve', name: 'aws-serve' },
    { family: 'serve', name: 'gcp-serve' },
    { family: 'serve-upgrade', name: 'aws-serve-upgrade' },
  ];

  test('accepts an annotation naming exactly the multi-target families', () => {
    expect(
      validateClassTableScope(
        'class tables cover every multi-target family: persistent-vm, serve;',
        contracts,
      ),
    ).toEqual([]);
  });

  test('exempts a family that runs a single target', () => {
    // serve-upgrade has one member, so listing it would be the error.
    expect(
      validateClassTableScope(
        'class tables cover every multi-target family: persistent-vm, serve, serve-upgrade;',
        contracts,
      )[0],
    ).toContain('but the multi-target families are persistent-vm, serve');
  });

  test('rejects a multi-target family missing from the claim', () => {
    expect(
      validateClassTableScope(
        'class tables cover every multi-target family: serve;',
        contracts,
      )[0],
    ).toContain('claims class tables for serve');
  });

  test('rejects a claim that names no families at all', () => {
    expect(
      validateClassTableScope(
        'each family proves its class table exhaustive.',
        contracts,
      )[0],
    ).toContain('does not enumerate');
  });
});

// Fixtures use RFC number 9999 so the literal tokens below can never satisfy
// a real RFC's coverage claim when the validator sweeps test/ for tokens.
const scenarios = (...coverage: string[]): string =>
  [
    '## Acceptance scenarios',
    '',
    '| ID  | Scenario | Required result | Coverage |',
    '| --- | --- | --- | --- |',
    ...coverage.map(
      (cell, index) =>
        `| S${index + 1} | Scenario ${index + 1} | Result ${index + 1} | ${cell} |`,
    ),
    '',
    '## Tracking',
    '',
  ].join('\n');

function scenarioInventory(
  overrides: {
    testTokens?: Set<string>;
    rfcNumbers?: Set<string>;
    required?: boolean;
  } = {},
) {
  return {
    testTokens: new Set(['9999/S1', '9999/S2']),
    rfcNumbers: new Set(['9999', '9998']),
    required: true,
    ...overrides,
  };
}

describe('acceptance-scenario coverage validation', () => {
  test('accepts a covered table under every tag', () => {
    expect(
      validateScenarioCoverage(
        'RFC 9999',
        '9999',
        scenarios(
          'test:9999/S1 — unit spec',
          'review — compares meanings, not shapes',
          'deferred:9998 — moved with its feature',
        ),
        scenarioInventory(),
      ),
    ).toEqual([]);
  });

  // Registration turns the missing Coverage column from optional into an
  // error.
  test('requires the Coverage column of a registered RFC', () => {
    const legacy = [
      '## Acceptance scenarios',
      '',
      '| ID  | Scenario | Required result |',
      '| --- | --- | --- |',
      '| S1  | Runtime loss | Retries nonterminal Jobs. |',
      '',
      '## Tracking',
      '',
    ].join('\n');

    expect(
      validateScenarioCoverage('RFC 9999', '9999', legacy, scenarioInventory()),
    ).toEqual(['RFC 9999 scenario table must carry a Coverage column']);
    expect(
      validateScenarioCoverage(
        'RFC 9999',
        '9999',
        legacy,
        scenarioInventory({ required: false }),
      ),
    ).toEqual([]);
  });

  test('requires a registered RFC to have a scenario table at all', () => {
    expect(
      validateScenarioCoverage(
        'RFC 9999',
        '9999',
        '## Summary\n\nNothing.\n',
        scenarioInventory(),
      ),
    ).toEqual(['RFC 9999 has no acceptance-scenario table']);
  });

  // A scenario cannot borrow another row's test: the token embeds the row ID,
  // so the cell and the row must agree.
  test('rejects a test cell citing another row', () => {
    expect(
      validateScenarioCoverage(
        'RFC 9999',
        '9999',
        scenarios('review — held', 'test:9999/S1 — unit spec'),
        scenarioInventory(),
      ),
    ).toEqual([
      'RFC 9999 scenario S2 must cite test:9999/S2, found test:9999/S1',
    ]);
  });

  test('rejects a cited token no test carries', () => {
    expect(
      validateScenarioCoverage(
        'RFC 9999',
        '9999',
        scenarios('test:9999/S1 — unit spec'),
        scenarioInventory({ testTokens: new Set() }),
      ),
    ).toEqual([
      'RFC 9999 scenario S1 cites 9999/S1, but no test carries that token',
    ]);
  });

  test('requires review coverage to say why', () => {
    expect(
      validateScenarioCoverage(
        'RFC 9999',
        '9999',
        scenarios('review'),
        scenarioInventory(),
      ),
    ).toEqual(['RFC 9999 scenario S1 rests on review without a reason']);
  });

  test('rejects a deferral to an RFC that does not exist', () => {
    expect(
      validateScenarioCoverage(
        'RFC 9999',
        '9999',
        scenarios('deferred:0042 — moved'),
        scenarioInventory(),
      ),
    ).toEqual([
      'RFC 9999 scenario S1 defers to an RFC that does not exist: 0042',
    ]);
  });

  test('rejects a tag outside the closed vocabulary', () => {
    expect(
      validateScenarioCoverage(
        'RFC 9999',
        '9999',
        scenarios('vibes — feels covered'),
        scenarioInventory(),
      ),
    ).toEqual(['RFC 9999 scenario S1 has an unknown coverage tag: vibes']);
  });

  // Voluntary adoption: an unregistered RFC's table that carries the column is
  // validated like a registered one.
  test('validates a voluntary Coverage column while unregistered', () => {
    expect(
      validateScenarioCoverage(
        'RFC 9999',
        '9999',
        scenarios('test:9999/S1 — unit spec'),
        scenarioInventory({ required: false }),
      ),
    ).toEqual([]);
    expect(
      validateScenarioCoverage(
        'RFC 9999',
        '9999',
        scenarios('review'),
        scenarioInventory({ required: false }),
      ),
    ).toEqual(['RFC 9999 scenario S1 rests on review without a reason']);
  });
});
