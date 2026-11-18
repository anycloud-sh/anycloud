import { REPEATABILITY } from './repeatability-policy.mjs';

const sequence = REPEATABILITY.endpoints;
const isolated = ['terminal-status'];

/** Diagnostic evidence never supplies qualification samples. */
export const STATUS_CONTROL = {
  ...REPEATABILITY,
  id: 'list-status-control-v1',
  replacesInvalidStudy: null,
  followsStudy: REPEATABILITY.id,
  purpose: 'Diagnostic attribution only; no timing qualification',
  executionBudgetMs: 20 * 60_000,
  repetitions: 0,
  setupTrials: [],
  diagnosticTrials: [
    {
      id: 'sequence-baseline',
      arm: 'baseline',
      caseIds: sequence,
      firstCaseId: 'ordinary-1000',
    },
    {
      id: 'sequence-candidate',
      arm: 'candidate',
      caseIds: sequence,
      firstCaseId: 'ordinary-1000',
    },
    {
      id: 'isolated-candidate',
      arm: 'candidate',
      caseIds: isolated,
      firstCaseId: 'terminal-status',
    },
    {
      id: 'isolated-baseline',
      arm: 'baseline',
      caseIds: isolated,
      firstCaseId: 'terminal-status',
    },
  ],
  stop: 'Exactly four diagnostic trials; no replacements or qualification. Stop without a demonstrated cause.',
};
