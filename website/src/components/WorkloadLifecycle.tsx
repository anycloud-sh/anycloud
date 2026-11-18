import React, { type ReactNode } from 'react';

import styles from './WorkloadLifecycle.module.css';

type LifecycleKind = 'job' | 'service';

type State = {
  emoji: string;
  name: string;
  description: string;
  optional?: boolean;
};

const QUEUED: State = {
  emoji: '⏳',
  name: 'queued',
  description: 'Waiting for capacity or for a spend control to clear',
};

const SETUP: Record<LifecycleKind, State[]> = {
  job: [
    {
      emoji: '🏗️',
      name: 'provisioning',
      description: 'Create the VM',
    },
    {
      emoji: '⚙️',
      name: 'initializing',
      description: 'Install the host runtime',
    },
    {
      emoji: '📥',
      name: 'downloading',
      description: 'Pull the container image',
    },
    {
      emoji: '💾',
      name: 'syncing',
      description: 'Restore input or checkpoint data',
      optional: true,
    },
    {
      emoji: '🚀',
      name: 'starting',
      description: 'Start the container',
    },
  ],
  service: [
    {
      emoji: '🏗️',
      name: 'provisioning',
      description: 'Create backing capacity',
    },
    {
      emoji: '⚙️',
      name: 'initializing',
      description: 'Install the host runtime',
    },
    {
      emoji: '📥',
      name: 'downloading',
      description: 'Pull the container image',
    },
    {
      emoji: '🚀',
      name: 'starting',
      description: 'Start and check the service',
    },
  ],
};

const TERMINAL_STATES: State[] = [
  {
    emoji: '❌',
    name: 'failed',
    description: 'Required retries exhausted',
  },
  {
    emoji: '🚫',
    name: 'invalid',
    description: 'Configuration rejected',
  },
  {
    emoji: '🪦',
    name: 'terminated',
    description: 'Stopped by a user',
  },
];

function StateCard({
  state,
  compact = false,
  accent = false,
}: {
  state: State;
  compact?: boolean;
  accent?: boolean;
}): ReactNode {
  return (
    <div
      className={[
        styles.state,
        compact ? styles.compactState : '',
        accent ? styles.accentState : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className={styles.stateName}>
        <span aria-hidden="true">{state.emoji}</span>
        <code>{state.name}</code>
        {state.optional ? (
          <span className={styles.optional}>if used</span>
        ) : null}
      </div>
      <span className={styles.stateDescription}>{state.description}</span>
    </div>
  );
}

function Arrow({ label }: { label?: string }): ReactNode {
  return (
    <div className={styles.arrow} aria-hidden="true">
      {label ? <span>{label}</span> : null}
      <b>→</b>
    </div>
  );
}

function SetupPhase({ kind }: { kind: LifecycleKind }): ReactNode {
  return (
    <section className={`${styles.phase} ${styles.setupPhase}`}>
      <span className={styles.phaseLabel}>Setup</span>
      <div className={styles.setupStates}>
        {SETUP[kind].map((state, index) => (
          <React.Fragment key={state.name}>
            {index > 0 ? (
              <span className={styles.setupArrow} aria-hidden="true">
                ↓
              </span>
            ) : null}
            <StateCard state={state} compact />
          </React.Fragment>
        ))}
      </div>
    </section>
  );
}

function Loop({
  trigger,
  state,
}: {
  trigger: string;
  state: State;
}): ReactNode {
  return (
    <div className={styles.loop}>
      <span className={styles.trigger}>{trigger}</span>
      <span className={styles.loopArrow} aria-hidden="true">
        →
      </span>
      <span className={styles.loopState}>
        <span aria-hidden="true">{state.emoji}</span>
        <code>{state.name}</code>
      </span>
      <span className={styles.returnArrow} aria-hidden="true">
        ↩
      </span>
      <span className={styles.returnState}>
        ⏳ <code>queued</code>
      </span>
    </div>
  );
}

export default function WorkloadLifecycle({
  kind,
}: {
  kind: LifecycleKind;
}): ReactNode {
  const isJob = kind === 'job';
  const retryState: State = {
    emoji: '🛠️',
    name: 'retrying',
    description: 'Setup will run again',
  };
  const recoveryState: State = {
    emoji: '🔁',
    name: 'recovering',
    description: isJob
      ? 'Replace a preempted spot VM'
      : 'Replace the service during an upgrade',
  };

  return (
    <figure
      className={isJob ? `${styles.figure} ${styles.job}` : styles.figure}
      aria-label={`${isJob ? 'Job' : 'Service'} workload lifecycle`}
    >
      <figcaption className={styles.caption}>
        <strong>{isJob ? 'Job' : 'Service'} lifecycle</strong>
        <span>Happy path</span>
      </figcaption>

      <div className={styles.mainFlow}>
        <section className={styles.phase}>
          <span className={styles.phaseLabel}>Wait</span>
          <StateCard state={QUEUED} />
        </section>

        <Arrow />
        <SetupPhase kind={kind} />
        <Arrow />

        <section className={styles.phase}>
          <span className={styles.phaseLabel}>
            {isJob ? 'Execute' : 'Serve'}
          </span>
          <StateCard
            state={{
              emoji: '⚡',
              name: 'running',
              description: isJob
                ? 'The workload is executing'
                : 'The service is live at its URL',
            }}
            accent
          />
        </section>

        {isJob ? (
          <>
            <Arrow label="exits" />
            <section className={styles.phase}>
              <span className={styles.phaseLabel}>Preserve</span>
              <StateCard
                state={{
                  emoji: '🏁',
                  name: 'finalizing',
                  description: 'Save final artifacts',
                  optional: true,
                }}
              />
            </section>
            <Arrow />
            <section className={`${styles.phase} ${styles.resultPhase}`}>
              <span className={styles.phaseLabel}>Result</span>
              <StateCard
                state={{
                  emoji: '✅',
                  name: 'completed',
                  description: 'Exit code 0',
                }}
                compact
              />
              <span className={styles.branchLabel}>or</span>
              <StateCard
                state={{
                  emoji: '🪲',
                  name: 'errored',
                  description: 'Non-zero exit',
                }}
                compact
              />
            </section>
          </>
        ) : null}
      </div>

      <div className={styles.secondary}>
        <div className={styles.secondaryGroup}>
          <span className={styles.secondaryLabel}>Return paths</span>
          <div className={styles.loops}>
            <Loop trigger="Setup failure" state={retryState} />
            <Loop
              trigger={isJob ? 'Spot preemption' : 'Upgrade'}
              state={recoveryState}
            />
          </div>
        </div>

        <div className={styles.secondaryGroup}>
          <span className={styles.secondaryLabel}>Terminal exits</span>
          <div className={styles.terminals}>
            {TERMINAL_STATES.map((state) => (
              <div className={styles.terminal} key={state.name}>
                <span className={styles.terminalName}>
                  <span aria-hidden="true">{state.emoji}</span>
                  <code>{state.name}</code>
                </span>
                <span>{state.description}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </figure>
  );
}
