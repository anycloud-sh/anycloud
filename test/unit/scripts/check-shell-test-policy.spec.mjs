import { readFileSync } from 'node:fs';
import { loadYaml } from '@kubernetes/client-node';
import Parser from 'tree-sitter';
import { describe, expect, it, vi } from 'vitest';
import {
  validateJobQualification,
  validateShellTestExecution,
} from '../../../scripts/check-shell-test-policy.mjs';
import { validateSharedProviderPredicates } from '../../../scripts/repository-policy/shared-provider-predicates.mjs';

const commonPath = 'test/integration/helpers/common.sh';
const read = (path) =>
  readFileSync(new URL('../../../' + path, import.meta.url), 'utf8');
const providers = ['aws', 'gcp', 'azure', 'lambda'];
const qualification = () => loadYaml(read('.github/workflows/e2e-job.yml'));
const cleanupJob = (workflow, provider = 'azure') =>
  workflow.jobs['post-cleanup-' + provider];
const cleanupStep = (workflow, provider = 'azure') =>
  cleanupJob(workflow, provider).steps.find((value) =>
    value.run?.endsWith('tsx ci/cleanup/' + provider + '.ts'),
  );

describe('Job qualification guarantees', () => {
  it('accepts the real workflow, which has no Bash Job leg', () => {
    const workflow = qualification();
    expect(workflow.jobs).not.toHaveProperty('e2e-tests');
    expect(validateJobQualification(workflow)).toEqual([]);
    cleanupJob(workflow).if = '!cancelled() && always()';
    expect(validateJobQualification(workflow)).toEqual([]);
  });

  it.each([
    [
      'branch-dependent lock',
      (workflow) => {
        workflow.concurrency.group += '-' + '$' + '{{ github.ref }}';
      },
    ],
    [
      'cancelled in-progress runs',
      (workflow) => {
        workflow.concurrency['cancel-in-progress'] = true;
      },
    ],
  ])('rejects %s', (_label, mutate) => {
    const workflow = qualification();
    mutate(workflow);
    expect(validateJobQualification(workflow).length).toBeGreaterThan(0);
  });

  it.each(providers)(
    'requires enabled %s cleanup after test failure',
    (provider) => {
      for (const mutate of [
        (workflow) => {
          delete workflow.jobs['post-cleanup-' + provider];
        },
        (workflow) => {
          cleanupJob(workflow, provider).needs = [];
        },
        (workflow) => {
          cleanupJob(workflow, provider).if = false;
        },
        (workflow) => {
          cleanupStep(workflow, provider).if = false;
        },
        (workflow) => {
          cleanupStep(workflow, provider)['continue-on-error'] = true;
        },
        (workflow) => {
          cleanupStep(workflow, provider).run =
            'echo npx tsx ci/cleanup/' + provider + '.ts';
        },
        (workflow) => {
          cleanupStep(workflow, provider).run =
            'if false; then npx tsx ci/cleanup/' + provider + '.ts; fi';
        },
        (workflow) => {
          cleanupStep(workflow, provider).run += ' || true';
        },
      ]) {
        const workflow = qualification();
        mutate(workflow);
        expect(validateJobQualification(workflow)).toContainEqual(
          expect.stringContaining('cleanup'),
        );
      }
    },
  );
});

describe('mandatory shell test execution', () => {
  it.each([
    'exit 77',
    'return "77"',
    'builtin exit 77',
    'if false; then assert "status" check_status; fi',
    'main() { assert "status" check_status; }\nexit 0',
    'if ! true; then assert "status" check_status; fi',
    'if test 1 = 2; then assert "status" check_status; fi',
    'if command false; then assert "status" check_status; fi',
    'if false && true; then assert "status" check_status; fi',
    'if ((0)); then assert "status" check_status; fi',
    'exit 0\nassert "status" check_status',
    'exit\nassert "status" check_status',
    'echo pass\ntrue',
    '/bin/true',
    'test x = x',
    '[ x = x ]',
    '[[ x == x ]]',
    "bash -c ':'",
    "command sh -c 'true'",
    'bash /dev/null',
    'false || assert "status" check_status',
    'false && anycloud status',
    'if [ 2 -lt 1 ]; then assert "status" check_status; fi',
    'if ((1 - 1)); then anycloud status; fi',
    'case x in y) assert "status" check_status ;; esac',
    'for item in; do assert "status" check_status; done',
    'main() { if [ 2 -lt 1 ]; then assert "status" check_status; fi; }\nmain',
    'main() { exit 0; assert "status" check_status; }\nmain',
    'main() { return; assert "status" check_status; }\nmain',
    'main() { if true; then exit 0; fi; assert "status" check_status; }\nmain',
    'main() { if missing; then return; fi; assert "status" check_status; }\nmain',
    'noop() { echo pass; true; }\nnoop',
    'E2E_FAIL_ON_SKIP=false',
    'if [ "${E2E_FAIL_ON_SKIP:-false}" = false ]; then exit 0; fi',
    'export REQUIRE_AZURE_QUOTA_CHECKS=false',
    'if [ "$AZURE_QUOTA_CHECKS" = true ]; then seed_azure_credentials; fi',
    'AZURE_PARITY_SKIPPED=true',
    'NUKE_MEMORY_GATES=false',
    'if [ "$NUKE_FAIRNESS_ENABLED" = true ]; then assert_fairness; fi',
  ])('rejects skipped assertions: %s', (source) => {
    expect(validateShellTestExecution(source).length).toBeGreaterThan(0);
  });

  it('allows asserted outcomes and ignores skip examples in comments and fixtures', () => {
    expect(
      validateShellTestExecution(`
      # exit 77 is forbidden
      printf '%s' 'exit 77'
      cat <<'EXAMPLE'
      exit 77
EXAMPLE
      if assert_valid_rejection; then return 0; fi
      exit "$RC"
    `),
    ).toEqual([]);
  });

  it('allows a direct shell script scenario without treating inline shell as proof', () => {
    expect(
      validateShellTestExecution('bash ./test/integration/real.test.sh'),
    ).toEqual([]);
  });

  it('does not treat a successful exit in a subshell as exiting its caller', () => {
    expect(
      validateShellTestExecution(`
        main() {
          (exit 0)
          assert_valid_rejection
        }
        main
      `),
    ).toEqual([]);
  });

  it.each([
    [
      'subshell exit',
      'main() { (exit 0); assert_valid_rejection; }\nmain',
      true,
    ],
    [
      'command substitution exit',
      'main() { result=$(exit 0); assert_valid_rejection; }\nmain',
      true,
    ],
    [
      'invoked nested function',
      'main() { inner() { assert_valid_rejection; }; inner; }\nmain',
      true,
    ],
    [
      'same-function exit',
      'main() { exit 0; assert_valid_rejection; }\nmain',
      false,
    ],
    [
      'same-function return',
      'main() { return; assert_valid_rejection; }\nmain',
      false,
    ],
    [
      'uninvoked nested function',
      'main() { inner() { assert_valid_rejection; }; :; }\nmain',
      false,
    ],
  ])(
    'preserves %s semantics with distinct native-node wrappers',
    (_, source, allowed) => {
      const expected = allowed
        ? []
        : [
            'Shell tests must execute a top-level scenario command; definitions and setup alone cannot prove assertions ran.',
          ];
      expect(validateShellTestExecution(source)).toEqual(expected);
      const getParent = Object.getOwnPropertyDescriptor(
        Parser.SyntaxNode.prototype,
        'parent',
      ).get;
      let wrapperPair;
      const parent = vi.spyOn(Parser.SyntaxNode.prototype, 'parent', 'get');
      parent.mockImplementation(function () {
        const node = getParent.call(this);
        if (!node) return node;
        const wrapper = Object.create(
          Object.getPrototypeOf(node),
          Object.getOwnPropertyDescriptors(node),
        );
        wrapperPair ??= [node, wrapper];
        return wrapper;
      });
      try {
        expect(validateShellTestExecution(source)).toEqual(expected);
        expect(parent).toHaveBeenCalled();
        const [node, wrapper] = wrapperPair;
        expect(wrapper).not.toBe(node);
        expect(wrapper.tree).toBe(node.tree);
        expect(wrapper.id).toBe(node.id);
      } finally {
        parent.mockRestore();
      }
    },
  );
});

describe('shared shell provider ownership', () => {
  it('finds no provider predicate in the shared helpers', () => {
    expect(validateSharedProviderPredicates(read(commonPath))).toEqual([]);
  });

  it.each([
    'if [ "$provider" = "Azure" ]; then echo special; fi',
    'if [[ "${cloudType}" == AWS ]]; then echo special; fi',
    'if\n [ "$provider" = GCP ]\nthen echo special; fi',
    'case "$provider" in Azure) echo special ;; esac',
    '[[ "$provider" == Lambda ]] && echo special',
    'if test "$provider" = Azure; then echo special; fi',
    'case "$target" in azure|gcp) echo special ;; esac',
  ])(
    'rejects new provider predicates regardless of shell spelling: %s',
    (condition) => {
      expect(
        validateSharedProviderPredicates(
          `new_shared_helper() {\n${condition}\n}`,
        ),
      ).toContainEqual(
        expect.stringContaining('new_shared_helper branches on a provider'),
      );
    },
  );

  it('allows generic evidence and checkpoint input assertions', () => {
    expect(
      validateSharedProviderPredicates(
        'if [ -n "$checkpoint_region" ]; then\n [ "$recovered_cloud_id" != "$cloud_id" ] || fail recovery\nfi',
      ),
    ).toEqual([]);
  });
});
