export const PROTECTED_ESLINT_RULES = Object.freeze([
  'local/api-contract-builder-ownership',
  'local/api-contract-inspection-ownership',
  'local/workload-admission-write-ownership',
  'local/container-spec-write-ownership',
  'local/workload-event-metadata-ownership',
  'local/environment-access-ownership',
  'local/explicit-api-provider-credentials',
  'local/exact-vm-compute-ownership',
  'local/literal-module-loads',
  'local/no-barrel-reexports',
  'local/no-test-mode-in-provider-runtime',
  'local/no-skipped-or-focused-tests',
  'local/no-uncontracted-api-routes',
  'local/protected-rule-disable-policy',
  'no-eval',
  'no-implied-eval',
  'no-new-func',
  'no-restricted-imports',
  '@typescript-eslint/no-restricted-imports',
]);

export const PROTECTED_ESLINT_EXCEPTIONS = Object.freeze([]);

function unqualifiedRule(rule) {
  const separator = rule.lastIndexOf('/');
  return separator === -1 ? rule : rule.slice(separator + 1);
}

export function protectedRuleIdentity(rule, protectedRules) {
  return protectedRules.find(
    (protectedRule) =>
      rule === protectedRule || rule === unqualifiedRule(protectedRule),
  );
}

function parseDisableDirective(value) {
  const match = value.match(
    /^\s*eslint-disable(?<scope>-next-line|-line)?(?:\s+(?<body>[\s\S]*?))?\s*$/u,
  );
  if (!match?.groups) return undefined;

  const body = match.groups.body?.trim() ?? '';
  const separator = body.indexOf('--');
  const rulesText = (separator === -1 ? body : body.slice(0, separator)).trim();
  return {
    scope: match.groups.scope ?? 'file',
    rules: rulesText.split(/[\s,]+/u).filter(Boolean),
    reason: separator === -1 ? '' : body.slice(separator + 2).trim(),
  };
}

function exceptionMatches(exception, { file, line, rule, reason }) {
  return (
    exception.file === file &&
    exception.line === line &&
    exception.rule === rule &&
    exception.reason === reason
  );
}

export function validateEslintDirectiveComments({
  file,
  comments,
  protectedRules = PROTECTED_ESLINT_RULES,
  exceptions = PROTECTED_ESLINT_EXCEPTIONS,
}) {
  const violations = [];

  function report(line, message) {
    violations.push({ file, line, message });
  }

  for (const comment of comments) {
    const line = comment.loc.start.line;
    const disable = parseDisableDirective(comment.value);
    if (disable) {
      const disablesWatchdog = disable.rules.some(
        (rule) =>
          protectedRuleIdentity(rule, protectedRules) ===
          'local/protected-rule-disable-policy',
      );
      if (disablesWatchdog) {
        report(
          line,
          'The protected-rule directive policy cannot disable itself.',
        );
        continue;
      }
      if (disable.scope !== '-next-line') {
        report(
          line,
          'ESLint disables must target exactly one rule on the next line; file-wide and same-line disables are forbidden.',
        );
        continue;
      }
      if (disable.rules.length !== 1) {
        report(
          line,
          'ESLint disable-next-line directives must name exactly one rule.',
        );
        continue;
      }

      const [writtenRule] = disable.rules;
      const protectedRule = protectedRuleIdentity(writtenRule, protectedRules);
      if (!protectedRule) continue;
      if (writtenRule !== protectedRule) {
        report(
          line,
          `Protected ESLint exceptions must use the exact rule name ${protectedRule}.`,
        );
        continue;
      }
      if (!disable.reason) {
        report(
          line,
          `Protected ESLint exception ${protectedRule} requires a reviewed rationale after --.`,
        );
        continue;
      }
      if (
        !exceptions.some((exception) =>
          exceptionMatches(exception, {
            file,
            line,
            rule: protectedRule,
            reason: disable.reason,
          }),
        )
      ) {
        report(
          line,
          `Protected ESLint exception ${protectedRule} is not present in the central repository-policy allowlist.`,
        );
      }
      continue;
    }

    if (/^\s*eslint(?:\s|$)/u.test(comment.value)) {
      report(
        line,
        'Inline ESLint rule configuration is forbidden; configure rules centrally in eslint.config.mjs.',
      );
    }
  }

  return violations;
}
