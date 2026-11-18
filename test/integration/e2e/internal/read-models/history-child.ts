import {
  historyDatabase,
  inspectHistory,
  parseHistoryChildOptions,
  queryHistory,
  writeHistoryResult,
} from './history-probes.js';

// The budgeted probe entry. It loads the store modules only — the same set the
// legacy `monitor query scans` probe loaded — so its six-second budget measures
// the read models, not the API's module graph. `recover` and `serve` need the
// monitor and the API respectively and have their own entries.
const options = parseHistoryChildOptions(['inspect', 'queries']);
const db = await historyDatabase();
await writeHistoryResult(
  options.output,
  options.action === 'queries'
    ? await queryHistory(db)
    : await inspectHistory(db),
);
