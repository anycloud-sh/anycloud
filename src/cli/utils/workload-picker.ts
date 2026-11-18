import type { WorkloadListRow } from '../../shared/api-contract/workload-management-schemas.js';
import type { WorkloadState } from '../../shared/workload.js';
import { formatWorkloadChoices } from './output.js';
import { suggestFilter } from './suggest-filter.js';
import { safePrompts as prompts } from './safe-prompts.js';

export async function selectWorkload(
  workloads: WorkloadListRow[],
): Promise<{ id: string; state: WorkloadState } | undefined> {
  const selection = await prompts({
    type: 'autocomplete',
    name: 'workload',
    message: 'Select workload',
    hint: '⌨️  Type to filter',
    choices: formatWorkloadChoices(workloads),
    suggest: suggestFilter,
  });

  return selection.workload;
}

export async function selectWorkloads(
  workloads: WorkloadListRow[],
): Promise<string[] | undefined> {
  const choices = formatWorkloadChoices(workloads).map((choice) => ({
    ...choice,
    value: choice.value.id,
  }));
  const selection = await prompts({
    type: 'autocompleteMultiselect',
    name: 'workloads',
    message: 'Select workloads',
    hint: '⌨️  Type to filter, Space to select, Enter to confirm',
    choices,
    suggest: suggestFilter,
  });

  return selection.workloads;
}
