import React, { type ReactNode } from 'react';

import styles from './SessionSpendCaps.module.css';

const LABEL_INDENT = 2;
const SESSION_INDENT = 4;
const LABEL_WIDTH = 20;
const BAR_WIDTH = 10;

type SpendRow = {
  name: string;
  percent: number;
  current: string;
  cap: string;
  trailing: string;
};

type SpendSnapshot = {
  command: ReactNode;
  heading: string;
  subhead: string;
  perSessionCap: string;
  rows: SpendRow[];
};

const BUDGET = {
  command: (
    <>
      budget set <span className="num">4000</span>{' '}
      <span className="flag">--per</span> day{' '}
      <span className="flag">--agent-session</span>
    </>
  ),
  heading: 'Budget',
  subhead: 'day  (resets in 19h)',
  perSessionCap: 'cap $4,000 each',
  rows: [
    {
      name: 'csp-rank',
      percent: 96,
      current: '$3,848',
      cap: '$4,000',
      trailing: '$152 left',
    },
    {
      name: 'free-energy-rerank',
      percent: 78,
      current: '$3,136',
      cap: '$4,000',
      trailing: '$864 left',
    },
    {
      name: 'blind-test-eval',
      percent: 9,
      current: '$368',
      cap: '$4,000',
      trailing: '$3,632 left',
    },
  ] satisfies SpendRow[],
} satisfies SpendSnapshot;

const THROTTLE = {
  command: (
    <>
      throttle set <span className="num">300</span>{' '}
      <span className="flag">--agent-session</span>
    </>
  ),
  heading: 'Throttle',
  subhead: '$/hr right now',
  perSessionCap: 'cap $300/hr each',
  rows: [
    {
      name: 'csp-rank',
      percent: 96,
      current: '$289.25',
      cap: '$300/hr',
      trailing: '$10.75/hr headroom',
    },
  ] satisfies SpendRow[],
} satisfies SpendSnapshot;

function spendBar(percent: number): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * BAR_WIDTH);
  return '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
}

function spendColor(percent: number): string {
  if (percent >= 90) return 'barRed';
  if (percent >= 70) return 'barYellow';
  return 'barGreen';
}

function spendRow(r: SpendRow): ReactNode {
  const label = (' '.repeat(SESSION_INDENT) + r.name).padEnd(
    LABEL_INDENT + LABEL_WIDTH,
  );
  const cls = spendColor(r.percent);
  const pct = `${Math.round(r.percent)}`.padStart(2, ' ') + '%';
  return (
    <>
      {label}
      {'  '}
      <span className={cls}>{spendBar(r.percent)}</span>
      {'  '}
      <span className={cls}>{pct}</span>
      {'  '}
      {r.current.padStart(8)}
      {' / '}
      {r.cap.padEnd(10)}
      {'  '}
      <span className="snapDim">{r.trailing}</span>
    </>
  );
}

type SessionSpendCapsProps = {
  compact?: boolean;
  mode?: 'budget' | 'throttle';
};

export default function SessionSpendCaps({
  compact = false,
  mode = 'budget',
}: SessionSpendCapsProps): ReactNode {
  const snapshot = mode === 'throttle' ? THROTTLE : BUDGET;
  const lines: ReactNode[] = [
    <>
      <span className="snapDim">$</span> <span className="fn">anycloud</span>{' '}
      {snapshot.command}
    </>,
    '',
    <>
      <span className="snapHead">{snapshot.heading}</span>
      <span className="snapDim">{'  ' + snapshot.subhead}</span>
    </>,
    <>
      {'  per agent-session'}
      <span className="snapDim">{'  ' + snapshot.perSessionCap}</span>
    </>,
    ...snapshot.rows.map((r) => spendRow(r)),
  ];

  return (
    <div className={`${styles.wrap} ${compact ? styles.compact : ''}`}>
      <pre className={styles.codePane}>
        {lines.map((line, index) => (
          <React.Fragment key={index}>
            {index > 0 ? '\n' : ''}
            {line}
          </React.Fragment>
        ))}
      </pre>
    </div>
  );
}
