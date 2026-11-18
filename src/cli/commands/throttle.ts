import { Command } from 'commander';
import { apiClient } from '../services/auth.js';
import type { SpendScope } from '../../shared/api-contract/spend-controls-schemas.js';
import { printError, printSuccess } from '../utils/output.js';
import { requireOrPrompt } from '../utils/safe-prompts.js';
import { parseUsdCap } from './shared.js';

function scopeFromFlags(agentSession: boolean | undefined): SpendScope {
  return agentSession ? 'agent-session' : 'account';
}

function scopeLabel(scope: SpendScope): string {
  return scope === 'account' ? 'account-wide' : 'per agent-session';
}

function createSetCommand(): Command {
  return new Command('set')
    .description('Set the burn-rate throttle cap ($/hr at any instant)')
    .argument('[usd]', 'Cap in whole USD (e.g. 20 for $20/hr)')
    .option(
      '--agent-session',
      'Apply cap per agent-session instead of account-wide',
    )
    .action(
      async (usd: string | undefined, opts: { agentSession?: boolean }) => {
        try {
          const cap = await requireOrPrompt(usd, {
            parse: parseUsdCap,
            missingError:
              'Cap required. Pass as first arg, e.g. anycloud throttle set 20.',
            prompt: {
              type: 'number',
              name: 'value',
              message: 'Throttle cap (USD/hr)',
              validate: (v) =>
                typeof v === 'number' && v > 0 && Number.isInteger(v)
                  ? true
                  : 'Must be a positive integer',
            },
          });
          const scope = scopeFromFlags(opts.agentSession);
          const api = await apiClient();
          await api.spend.throttles.set({
            params: { scope },
            body: { capUsd: cap },
          });
          printSuccess(`Throttle set: $${cap}/hr (${scopeLabel(scope)})`);
        } catch (err) {
          printError(`Failed to set throttle: ${(err as Error).message}`);
          process.exit(1);
        }
      },
    );
}

function createShowCommand(): Command {
  return new Command('show')
    .description('Show active throttles and current burn rate')
    .action(async () => {
      try {
        const api = await apiClient();
        const { entries, burnRate } = await api.spend.throttles.list();
        if (entries.length === 0) {
          process.stdout.write('No throttles set. Set one with:\n');
          process.stdout.write('  anycloud throttle set 20\n');
          return;
        }
        // Piped output gets a (N%) suffix so agents/scripts don't redo the math.
        // TTY format unchanged.
        const showPercent = !process.stdout.isTTY;
        for (const t of entries) {
          if (t.scope === 'account') {
            const cur = burnRate.account.currentUsd;
            const pct = t.capUsd > 0 ? Math.round((cur / t.capUsd) * 100) : 0;
            const suffix = showPercent ? ` (${pct}%)` : '';
            process.stdout.write(
              `account: $${cur.toFixed(2)}/hr current / $${t.capUsd}/hr cap${suffix}\n`,
            );
          } else if (showPercent && burnRate.sessions) {
            // For piped output, expose per-session rates so callers can read
            // %-used per session. TTY output stays compact.
            process.stdout.write(
              `agent-session: $${t.capUsd}/hr per session\n`,
            );
            for (const s of burnRate.sessions) {
              const pct =
                t.capUsd > 0 ? Math.round((s.rateUsd / t.capUsd) * 100) : 0;
              const label =
                s.sessionLabel ??
                (s.agent ? `${s.agent}:${s.session}` : s.session);
              process.stdout.write(
                `  ${label}: $${s.rateUsd.toFixed(2)}/hr (${pct}%)\n`,
              );
            }
          } else {
            // Per-session burn rate depends on which sessions are active right
            // now; listing all of them is open-ended, so show the cap only.
            process.stdout.write(
              `agent-session: $${t.capUsd}/hr per session\n`,
            );
          }
        }
      } catch (err) {
        printError(`Failed to fetch throttles: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}

function createUnsetCommand(): Command {
  return new Command('unset')
    .description('Remove the throttle for a scope')
    .option(
      '--agent-session',
      'Remove the per-agent-session throttle instead of account',
    )
    .action(async (opts: { agentSession?: boolean }) => {
      try {
        const scope = scopeFromFlags(opts.agentSession);
        const api = await apiClient();
        await api.spend.throttles.unset({
          params: { scope },
        });
        printSuccess(`Throttle removed (${scopeLabel(scope)})`);
      } catch (err) {
        printError(`Failed to unset throttle: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}

export function createThrottleCommand(): Command {
  const throttle = new Command('throttle')
    .description(
      '🚦 Burn-rate cap ($/hr). Blocks new dispatches when running VMs already burn at the cap; running jobs keep going.',
    )
    .addHelpText(
      'after',
      `
Throttle caps the live burn rate — the sum of $/hr across running VMs at this
instant, plus the candidate's $/hr if dispatched. Pair with 'budget' for
calendar-window total caps. Throttle doesn't kill running jobs — it leaves
new submits Queued until enough VMs end to fit the candidate under the cap.

Scopes:
  (default)         account-wide: total $/hr across everything
  --agent-session   each agent session capped independently

Examples:
  $ anycloud throttle set                       (prompts for cap)
  $ anycloud throttle set 20
  $ anycloud throttle set 5 --agent-session
  $ anycloud throttle show
  $ anycloud throttle unset
  $ anycloud throttle unset --agent-session
`,
    );

  throttle.addCommand(createSetCommand());
  throttle.addCommand(createShowCommand());
  throttle.addCommand(createUnsetCommand());

  return throttle;
}
