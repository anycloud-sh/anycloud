import { runWorkloadReconcileOnce } from '../../../../../src/api/services/monitor.js';
import {
  historyDatabase,
  inspectHistory,
  parseHistoryChildOptions,
  writeHistoryResult,
} from './history-probes.js';

// Immediate active recovery over the seeded history, then the same inspection
// the light entry performs. Loading the monitor is why this is its own entry.
const options = parseHistoryChildOptions(['recover']);
const db = await historyDatabase();
await runWorkloadReconcileOnce({ activeRecoveryNow: true });
await writeHistoryResult(options.output, await inspectHistory(db));
