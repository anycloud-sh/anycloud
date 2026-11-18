import { safePrompts } from '../utils/safe-prompts.js';
import { suggestFilter } from '../utils/suggest-filter.js';

/** The list view picker; Enter keeps the "all" view. */
export async function pickListView<V extends string>(
  choices: Array<{ title: string; value: V }>,
): Promise<V | undefined> {
  const selection = await safePrompts<'view'>({
    type: 'select',
    name: 'view',
    message: 'Select view',
    choices,
    initial: choices.findIndex((choice) => choice.value === '__all__'),
  });
  return selection.view as V | undefined;
}

/** A type-to-filter picker answering the chosen value, or undefined on cancel. */
export async function pickFiltered<N extends string>(
  name: N,
  message: string,
  choices: Array<{ title: string; value: string }>,
): Promise<string | undefined> {
  const selection = await safePrompts<N>({
    type: 'autocomplete',
    name,
    message,
    hint: '⌨️  Type to filter',
    choices,
    suggest: suggestFilter,
  });
  return selection[name] as string | undefined;
}
