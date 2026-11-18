import { Command } from 'commander';
import { apiClient } from '../services/auth.js';
import chalk from 'chalk';
import type {
  BudgetPeriod,
  ListBudgetsResponse,
  ListThrottlesResponse,
  SessionBurn,
  SessionSpend,
} from '../../shared/api-contract/spend-controls-schemas.js';
import {
  formatPercentColored,
  formatResetRelative,
  printError,
  renderBar,
  setJsonMode,
} from '../utils/output.js';

interface SpendShowOptions {
  json?: boolean;
}

interface RenderedRow {
  // Indented label, already padded to LABEL_WIDTH
  label: string;
  percent: number; // 0–100
  current: string; // e.g. "$19.37"
  cap: string; // e.g. "$200/hr"
  trailing: string; // e.g. "$180.63/hr headroom"
}

const LABEL_INDENT = 2;
const SESSION_INDENT = 4;
const LABEL_WIDTH = 20; // outer column for "account" / "claude:abc123"
const PCT_WIDTH = 4; // "100%"
const BAR_WIDTH = 10;

function shortSession(
  session: string,
  agent: string | null,
  sessionLabel: string | null = null,
): string {
  if (sessionLabel) return sessionLabel;
  if (agent && session.length > 12) return `${agent}:${session.slice(0, 6)}`;
  return session;
}

/**
 * On an API shared with other GitHub accounts, a session label alone does not
 * say whose run is consuming the cap. Prefix the owner only when the rows
 * actually span more than one account, so an unshared API is unchanged.
 */
export function sessionLabeller(
  rows: Array<{ user: string | null }>,
): (row: {
  session: string;
  agent: string | null;
  sessionLabel: string | null;
  user: string | null;
}) => string {
  const users = new Set(rows.map((r) => r.user).filter(Boolean));
  if (users.size < 2) {
    return (r) => shortSession(r.session, r.agent, r.sessionLabel);
  }
  return (r) =>
    `${r.user ?? '?'}/${shortSession(r.session, r.agent, r.sessionLabel)}`;
}

function fmtUsd(n: number, fractionDigits: number = 2): string {
  return `$${n.toLocaleString('en-US', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })}`;
}

function pct(current: number, cap: number): number {
  if (cap <= 0) return 0;
  return (current / cap) * 100;
}

function renderRow(row: RenderedRow, useBar: boolean): string {
  const bar = useBar ? `  ${renderBar(row.percent, BAR_WIDTH)}` : '';
  const percentStr = formatPercentColored(row.percent);
  // Pad cap so trailing column lines up across rows (small luxury).
  return `${row.label}${bar}  ${percentStr}  ${row.current.padStart(8)} / ${row.cap.padEnd(10)}  ${row.trailing}`;
}

function renderThrottleSection(
  throttles: ListThrottlesResponse,
  useBar: boolean,
): string[] {
  const out: string[] = [];
  const account = throttles.entries.find((t) => t.scope === 'account');
  const session = throttles.entries.find((t) => t.scope === 'agent-session');
  if (!account && !session) return out;

  out.push(chalk.bold('Throttle') + chalk.dim('  $/hr right now'));

  if (account) {
    const current = throttles.burnRate.account.currentUsd;
    const cap = account.capUsd;
    const headroom = Math.max(0, cap - current);
    out.push(
      renderRow(
        {
          label: ' '.repeat(LABEL_INDENT) + 'account'.padEnd(LABEL_WIDTH),
          percent: pct(current, cap),
          current: fmtUsd(current),
          cap: `${fmtUsd(cap, 0)}/hr`,
          trailing: chalk.dim(`${fmtUsd(headroom)}/hr headroom`),
        },
        useBar,
      ),
    );
  }

  if (session) {
    const cap = session.capUsd;
    out.push(
      ' '.repeat(LABEL_INDENT) +
        'per agent-session' +
        chalk.dim(`  cap ${fmtUsd(cap, 0)}/hr each`),
    );
    const sessions: SessionBurn[] = (throttles.burnRate.sessions ?? [])
      .slice()
      .sort((a, b) => b.rateUsd - a.rateUsd);
    const sessionLabel = sessionLabeller(sessions);
    if (sessions.length === 0) {
      out.push(' '.repeat(SESSION_INDENT) + chalk.dim('(no sessions active)'));
    } else {
      for (const s of sessions) {
        const headroom = Math.max(0, cap - s.rateUsd);
        out.push(
          renderRow(
            {
              label:
                ' '.repeat(SESSION_INDENT) +
                sessionLabel(s).padEnd(
                  LABEL_WIDTH - (SESSION_INDENT - LABEL_INDENT),
                ),
              percent: pct(s.rateUsd, cap),
              current: fmtUsd(s.rateUsd),
              cap: `${fmtUsd(cap, 0)}/hr`,
              trailing: chalk.dim(`${fmtUsd(headroom)}/hr headroom`),
            },
            useBar,
          ),
        );
      }
    }
  }

  return out;
}

function renderBudgetSection(
  period: BudgetPeriod,
  budgets: ListBudgetsResponse,
  useBar: boolean,
): string[] {
  const out: string[] = [];
  const account = budgets.entries.find(
    (b) => b.period === period && b.scope === 'account',
  );
  const session = budgets.entries.find(
    (b) => b.period === period && b.scope === 'agent-session',
  );
  if (!account && !session) return out;

  const spend = budgets.spend.find(
    (s) => s.period === period && s.scope === 'account',
  );
  const resetLabel = spend
    ? `  (resets ${formatResetRelative(spend.endMs)})`
    : '';
  out.push(chalk.bold(`Budget`) + chalk.dim(`  ${period}${resetLabel}`));

  if (account && spend) {
    const total = spend.totalUsd;
    const cap = account.capUsd;
    const headroom = Math.max(0, cap - total);
    out.push(
      renderRow(
        {
          label: ' '.repeat(LABEL_INDENT) + 'account'.padEnd(LABEL_WIDTH),
          percent: pct(total, cap),
          current: fmtUsd(total),
          cap: fmtUsd(cap, 0),
          trailing: chalk.dim(`${fmtUsd(headroom)} left`),
        },
        useBar,
      ),
    );
    if (spend.estimatedUsd > 0) {
      // Continuation line under the account row — dim, aligned past the bar/%
      const prefix = useBar
        ? ' '.repeat(LABEL_INDENT + LABEL_WIDTH + 2 + BAR_WIDTH + 2 + PCT_WIDTH)
        : ' '.repeat(LABEL_INDENT + LABEL_WIDTH + 2 + PCT_WIDTH);
      out.push(
        prefix +
          chalk.dim(
            `  ${fmtUsd(spend.actualUsd)} settled · ${fmtUsd(spend.estimatedUsd)} estimate`,
          ),
      );
    }
  }

  if (session) {
    const cap = session.capUsd;
    out.push(
      ' '.repeat(LABEL_INDENT) +
        'per agent-session' +
        chalk.dim(`  cap ${fmtUsd(cap, 0)} each`),
    );
    const sessions: SessionSpend[] = (spend?.sessions ?? [])
      .slice()
      .sort((a, b) => b.totalUsd - a.totalUsd);
    const sessionLabel = sessionLabeller(sessions);
    if (sessions.length === 0) {
      out.push(' '.repeat(SESSION_INDENT) + chalk.dim('(no sessions active)'));
    } else {
      for (const s of sessions) {
        const headroom = Math.max(0, cap - s.totalUsd);
        out.push(
          renderRow(
            {
              label:
                ' '.repeat(SESSION_INDENT) +
                sessionLabel(s).padEnd(
                  LABEL_WIDTH - (SESSION_INDENT - LABEL_INDENT),
                ),
              percent: pct(s.totalUsd, cap),
              current: fmtUsd(s.totalUsd),
              cap: fmtUsd(cap, 0),
              trailing: chalk.dim(`${fmtUsd(headroom)} left`),
            },
            useBar,
          ),
        );
      }
    }
  }

  return out;
}

function emitJson(
  throttles: ListThrottlesResponse,
  budgets: ListBudgetsResponse,
): void {
  const throttleEntries = throttles.entries.map((t) => {
    if (t.scope === 'account') {
      const current = throttles.burnRate.account.currentUsd;
      return {
        ...t,
        currentUsd: current,
        percentUsed: pct(current, t.capUsd),
        headroomUsd: Math.max(0, t.capUsd - current),
      };
    }
    return {
      ...t,
      sessions: (throttles.burnRate.sessions ?? []).map((s) => ({
        ...s,
        percentUsed: pct(s.rateUsd, t.capUsd),
        headroomUsd: Math.max(0, t.capUsd - s.rateUsd),
      })),
    };
  });

  const budgetEntries = budgets.entries.map((b) => {
    const s = budgets.spend.find(
      (x) => x.period === b.period && x.scope === 'account',
    );
    const totalUsd = s?.totalUsd ?? 0;
    if (b.scope === 'account') {
      return {
        ...b,
        actualUsd: s?.actualUsd ?? 0,
        estimatedUsd: s?.estimatedUsd ?? 0,
        totalUsd,
        endMs: s?.endMs,
        percentUsed: pct(totalUsd, b.capUsd),
        headroomUsd: Math.max(0, b.capUsd - totalUsd),
      };
    }
    return {
      ...b,
      endMs: s?.endMs,
      sessions: (s?.sessions ?? []).map((x) => ({
        ...x,
        percentUsed: pct(x.totalUsd, b.capUsd),
        headroomUsd: Math.max(0, b.capUsd - x.totalUsd),
      })),
    };
  });

  process.stdout.write(
    JSON.stringify({ throttles: throttleEntries, budgets: budgetEntries }) +
      '\n',
  );
}

function createShowCommand(): Command {
  return new Command('show')
    .description('Show throttle + budget headroom across all caps')
    .option(
      '--json',
      'Emit JSON (drops bars + color; adds percentUsed/headroomUsd)',
    )
    .action(async (opts: SpendShowOptions) => {
      try {
        const tokenClient = await apiClient();
        if (opts.json) setJsonMode(true);
        const api = tokenClient;
        const [throttles, budgets] = await Promise.all([
          api.spend.throttles.list(),
          api.spend.budgets.list(),
        ]);

        if (opts.json) {
          emitJson(throttles, budgets);
          return;
        }

        if (throttles.entries.length === 0 && budgets.entries.length === 0) {
          process.stdout.write('No spend controls configured.\n');
          process.stdout.write('  anycloud throttle set 200\n');
          process.stdout.write('  anycloud budget set 3000 --per day\n');
          return;
        }

        const useBar = Boolean(process.stdout.isTTY);
        const blocks: string[][] = [];
        blocks.push(renderThrottleSection(throttles, useBar));
        for (const p of ['day', 'week', 'month'] as const) {
          blocks.push(renderBudgetSection(p, budgets, useBar));
        }
        const nonEmpty = blocks.filter((b) => b.length > 0);
        process.stdout.write(
          nonEmpty.map((b) => b.join('\n')).join('\n\n') + '\n',
        );
      } catch (err) {
        printError(`Failed to fetch spend status: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}

export function createSpendCommand(): Command {
  const spend = new Command('spend')
    .description(
      '📊 Unified throttle + budget status with headroom across all caps.',
    )
    .addHelpText(
      'after',
      `
Examples:
  $ anycloud spend show
  $ anycloud spend show --json
`,
    );

  spend.addCommand(createShowCommand(), { isDefault: true });

  return spend;
}
