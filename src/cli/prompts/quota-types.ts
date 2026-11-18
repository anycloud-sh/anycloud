import { safePrompts } from '../utils/safe-prompts.js';

export async function pickQuotaTypes(): Promise<boolean[]> {
  const selection = await safePrompts<'quotaType'>({
    type: 'select',
    name: 'quotaType',
    message: 'Quota type',
    hint: 'Choose one quota type',
    initial: 0,
    warn: 'Choose On-demand or Spot / preemptible',
    choices: [
      { title: 'On-demand', value: 'ondemand' },
      { title: 'Spot / preemptible', value: 'spot' },
    ],
  });
  const value = selection.quotaType;
  if (value === 'ondemand') return [false];
  if (value === 'spot') return [true];
  return [];
}
