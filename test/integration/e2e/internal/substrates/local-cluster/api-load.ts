import type { IncomingMessage, ServerResponse } from 'node:http';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

import type { DB } from '../../../../../../src/api/services/repositories/db.js';
import { spread } from '../../contracts/claim-burst.js';
import type { LocalKubernetesApiLoad } from './protocol.js';

/** The runner's claim-queue calls (`src/runner/api.ts`), by their route. */
const RUNNER_ROUTE =
  /^\/v1\/deployments\/[^/]+\/jobs\/(?:(candidate)|[^/]+\/(claim|execution|report|cancellation|cleanup))(?:\?|$)/u;

/**
 * S12: the claim path's cost inside the API process. The API's
 * SQLite runs every operation on one queue (`db.ts`), so a one-row query's
 * latency is the wait any claim transaction would see at that moment, and
 * the event loop's delay is the stall every request shares.
 */
export function createApiLoadMonitor(db: DB) {
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  let since = { at: performance.now(), cpu: process.cpuUsage() };
  let sqlite: number[] = [];
  let routes = new Map<
    string,
    { ms: number[]; errors: Record<string, number> }
  >();
  const probe = setInterval(() => {
    const start = performance.now();
    void db.query('SELECT 1').then(
      () => sqlite.push(performance.now() - start),
      () => undefined,
    );
  }, 250);
  probe.unref();

  return {
    request(request: IncomingMessage, response: ServerResponse): void {
      const start = performance.now();
      const match = RUNNER_ROUTE.exec(request.url ?? '');
      const route = match ? (match[1] ?? match[2]) : 'other';
      response.once('finish', () => {
        const entry = routes.get(route) ?? { ms: [], errors: {} };
        entry.ms.push(performance.now() - start);
        const status = String(response.statusCode);
        if (response.statusCode >= 500)
          entry.errors[status] = (entry.errors[status] ?? 0) + 1;
        routes.set(route, entry);
      });
    },
    /** Everything since the window opened; `close` opens the next one. */
    read(close: boolean): LocalKubernetesApiLoad {
      const now = performance.now();
      const cpu = process.cpuUsage(since.cpu);
      const result: LocalKubernetesApiLoad = {
        windowMs: Math.round(now - since.at),
        cpuCores: (cpu.user + cpu.system) / 1000 / (now - since.at),
        eventLoopP99Ms: loop.percentile(99) / 1e6,
        eventLoopMaxMs: loop.max / 1e6,
        sqliteWaitMs: spread(sqlite),
        routes: Object.fromEntries(
          [...routes].map(([route, { ms, errors }]) => [
            route,
            { ...spread(ms), errors },
          ]),
        ),
      };
      if (close) {
        loop.reset();
        since = { at: now, cpu: process.cpuUsage() };
        sqlite = [];
        routes = new Map();
      }
      return result;
    },
    stop(): void {
      clearInterval(probe);
      loop.disable();
    },
  };
}
