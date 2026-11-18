import { Command } from 'commander';
import { apiClient } from '../services/auth.js';
import type {
  BudgetPeriod,
  SpendScope,
} from '../../shared/api-contract/spend-controls-schemas.js';
import { printError, printSuccess } from '../utils/output.js';
import { requireOrPrompt } from '../utils/safe-prompts.js';
import { parseUsdCap } from './shared.js';

const VALID_PERIODS: readonly BudgetPeriod[] = ['day', 'week', 'month'];

function parsePeriod(raw: string): BudgetPeriod {
  if (!(VALID_PERIODS as readonly string[]).includes(raw)) {
    throw new Error(`--per must be one of: ${VALID_PERIODS.join(', ')}`);
  }
  return raw as BudgetPeriod;
}

function scopeFromFlags(agentSession: boolean | undefined): SpendScope {
  return agentSession ? 'agent-session' : 'account';
}

function scopeLabel(scope: SpendScope): string {
  return scope === 'account' ? 'account-wide' : 'per agent-session';
}

function formatReset(endMs: number): string {
  const d = new Date(endMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

function createSetCommand(): Command {
  return new Command('set')
    .description('Set a calendar-window spend cap')
    .argument('[usd]', 'Cap in whole USD (e.g. 100)')
    .option('--per <period>', `Window: ${VALID_PERIODS.join(' | ')}`)
    .option(
      '--agent-session',
      'Apply cap per agent-session instead of account-wide',
    )
    .action(
      async (
        usd: string | undefined,
        opts: { per?: string; agentSession?: boolean },
      ) => {
        try {
          const cap = await requireOrPrompt(usd, {
            parse: parseUsdCap,
            missingError:
              'Cap required. Pass as first arg, e.g. anycloud budget set 100 --per day.',
            prompt: {
              type: 'number',
              name: 'value',
              message: 'Budget cap (USD)',
              validate: (v) =>
                typeof v === 'number' && v > 0 && Number.isInteger(v)
                  ? true
                  : 'Must be a positive integer',
            },
          });
          const period = await requireOrPrompt(opts.per, {
            parse: parsePeriod,
            missingError: `--per required. One of: ${VALID_PERIODS.join(' | ')}.`,
            prompt: {
              type: 'select',
              name: 'value',
              message: 'Window',
              choices: VALID_PERIODS.map((p) => ({ title: p, value: p })),
            },
          });
          const scope = scopeFromFlags(opts.agentSession);
          const api = await apiClient();
          await api.spend.budgets.set({
            params: { period, scope },
            body: { capUsd: cap },
          });
          printSuccess(
            `Budget set: $${cap} per ${period} (${scopeLabel(scope)})`,
          );
        } catch (err) {
          printError(`Failed to set budget: ${(err as Error).message}`);
          process.exit(1);
        }
      },
    );
}

function createShowCommand(): Command {
  return new Command('show')
    .description('Show active budgets and current spend per window')
    .action(async () => {
      try {
        const api = await apiClient();
        const { entries, spend } = await api.spend.budgets.list();
        if (entries.length === 0) {
          process.stdout.write('No budgets set. Set one with:\n');
          process.stdout.write('  anycloud budget set 100 --per day\n');
          return;
        }
        // Piped output gets a (N%) suffix and per-session rows so agents
        // don't redo the math. TTY output unchanged.
        const showPercent = !process.stdout.isTTY;
        const accountSpendByPeriod = new Map(
          spend
            .filter((s) => s.scope === 'account')
            .map((s) => [s.period, s] as const),
        );
        for (const b of entries) {
          if (b.scope === 'account') {
            const s = accountSpendByPeriod.get(b.period);
            if (s) {
              const pct =
                b.capUsd > 0 ? Math.round((s.totalUsd / b.capUsd) * 100) : 0;
              const suffix = showPercent ? ` (${pct}%)` : '';
              process.stdout.write(
                `${b.period} (account):       $${s.totalUsd.toFixed(2)} / $${b.capUsd}  ` +
                  `($${s.actualUsd.toFixed(2)} actual + $${s.estimatedUsd.toFixed(2)} estimate)  ` +
                  `resets ${formatReset(s.endMs)}${suffix}\n`,
              );
            } else {
              process.stdout.write(
                `${b.period} (account):       $${b.capUsd}\n`,
              );
            }
          } else {
            const s = accountSpendByPeriod.get(b.period);
            const sessions =
              s?.agentSessionCount !== undefined
                ? `, ${s.agentSessionCount} session${s.agentSessionCount === 1 ? '' : 's'} active in window`
                : '';
            process.stdout.write(
              `${b.period} (agent-session): $${b.capUsd} per session${sessions}\n`,
            );
            if (showPercent && s?.sessions) {
              for (const r of s.sessions) {
                const pct =
                  b.capUsd > 0 ? Math.round((r.totalUsd / b.capUsd) * 100) : 0;
                const label =
                  r.sessionLabel ??
                  (r.agent ? `${r.agent}:${r.session}` : r.session);
                process.stdout.write(
                  `  ${label}: $${r.totalUsd.toFixed(2)} (${pct}%)\n`,
                );
              }
            }
          }
        }
      } catch (err) {
        printError(`Failed to fetch budgets: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}

function createUnsetCommand(): Command {
  return new Command('unset')
    .description('Remove a budget for a window/scope')
    .option('--per <period>', `Window: ${VALID_PERIODS.join(' | ')}`)
    .option(
      '--agent-session',
      'Remove the per-agent-session budget for this window instead of account',
    )
    .action(async (opts: { per?: string; agentSession?: boolean }) => {
      try {
        const period = await requireOrPrompt(opts.per, {
          parse: parsePeriod,
          missingError: `--per required. One of: ${VALID_PERIODS.join(' | ')}.`,
          prompt: {
            type: 'select',
            name: 'value',
            message: 'Window',
            choices: VALID_PERIODS.map((p) => ({ title: p, value: p })),
          },
        });
        const scope = scopeFromFlags(opts.agentSession);
        const api = await apiClient();
        await api.spend.budgets.unset({
          params: { period, scope },
        });
        printSuccess(`Budget removed: ${period} (${scopeLabel(scope)})`);
      } catch (err) {
        printError(`Failed to unset budget: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}

export function createBudgetCommand(): Command {
  const budget = new Command('budget')
    .description(
      '💰 Calendar-window spend cap (day/week/month). Blocks new dispatches when exceeded.',
    )
    .addHelpText(
      'after',
      `
Budget catches sustained drift over a calendar window. Pair with 'throttle'
for hourly burst protection. Caps don't kill running jobs — they leave new
submits Queued until the window resets or the cap is raised.

Windows reset at UTC boundaries:
  day    — 00:00 UTC
  week   — Monday 00:00 UTC
  month  — 1st of month, 00:00 UTC

Scopes:
  (default)         account-wide: total across everything
  --agent-session   each agent session capped independently (humans excluded)

Examples:
  $ anycloud budget set                         (prompts for cap + window)
  $ anycloud budget set 100 --per day
  $ anycloud budget set 2000 --per month
  $ anycloud budget set 50 --per day --agent-session
  $ anycloud budget show
  $ anycloud budget unset --per day
`,
    );

  budget.addCommand(createSetCommand());
  budget.addCommand(createShowCommand());
  budget.addCommand(createUnsetCommand());

  return budget;
}
