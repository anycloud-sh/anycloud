import React from 'react';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';

import SlackSpendCapAlert from '../../components/SlackSpendCapAlert';
import SlackVmReleaseAlert from '../../components/SlackVmReleaseAlert';
import styles from './slack.module.css';

const INSTALL_URL = 'https://slack.anycloud.sh/install';

export default function SlackLanding(): React.ReactElement {
  return (
    <Layout
      title="Slack cloud operations alerts"
      description="Send Anycloud delayed VM-release alerts, GPU spend alerts, daily cloud summaries, and new-release updates directly from your Anycloud server to Slack."
    >
      <main className={styles.page}>
        <section className={styles.hero}>
          <div className={`${styles.wrap} ${styles.heroGrid}`}>
            <div>
              <p className={styles.eyebrow}>Anycloud for Slack</p>
              <h1 className={styles.title}>
                Cloud operations alerts where your team already works
              </h1>
              <p className={styles.lede}>
                Send delayed VM-release alerts, GPU spend-cap alerts, daily
                workload summaries, and new release notes from your Anycloud
                server straight to a channel your team chooses. No hosted
                notification relay and no access to your Slack messages.
              </p>
              <div className={styles.actions}>
                <a className={styles.primary} href={INSTALL_URL}>
                  <img
                    className={styles.slackLogo}
                    src="/img/slack.svg"
                    alt=""
                  />
                  Add Anycloud to Slack
                </a>
                <Link
                  className={styles.secondary}
                  to="/platform/notifications/"
                >
                  Read the notification docs
                </Link>
              </div>
              <div
                className={styles.trustLine}
                aria-label="Integration properties"
              >
                <span className={styles.trustItem}>One permission</span>
                <span className={styles.trustItem}>Local delivery</span>
                <span className={styles.trustItem}>No Slack data reads</span>
              </div>
            </div>
            <div className={styles.heroCard}>
              <p className={styles.exampleLabel}>Delayed VM release</p>
              <SlackVmReleaseAlert compact />
            </div>
          </div>
        </section>

        <section className={`${styles.section} ${styles.sectionSoft}`}>
          <div className={styles.wrap}>
            <p className={styles.eyebrow}>Three steps</p>
            <h2 className={styles.sectionTitle}>
              Install once, deliver locally
            </h2>
            <p className={styles.sectionIntro}>
              A workspace administrator authorizes the destination channel.
              Slack creates a channel-specific webhook, and your Anycloud
              operator connects it to the server that already knows about your
              workloads and spend.
            </p>
            <div className={styles.steps}>
              <article className={styles.step}>
                <span className={styles.stepNumber}>01</span>
                <h3>Start from your server</h3>
                <p>
                  Run <code>anycloud notifications connect slack</code> on the
                  machine hosting your API. The CLI opens Slack or prints the
                  installation URL.
                </p>
              </article>
              <article className={styles.step}>
                <span className={styles.stepNumber}>02</span>
                <h3>Choose a channel</h3>
                <p>
                  Authorize Anycloud in your workspace, copy the channel
                  webhook, then paste it into the CLI's hidden prompt.
                </p>
              </article>
              <article className={styles.step}>
                <span className={styles.stepNumber}>03</span>
                <h3>Receive useful alerts</h3>
                <p>
                  Anycloud posts a test message immediately, followed by daily
                  summaries, actionable spend-cap notifications, delayed
                  VM-release warnings, and new-release updates.
                </p>
              </article>
            </div>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.wrap}>
            <p className={styles.eyebrow}>Local-first architecture</p>
            <h2 className={styles.sectionTitle}>
              Your cloud credentials never enter the Slack integration
            </h2>
            <p className={styles.sectionIntro}>
              Installation uses a small OAuth service. Notification delivery
              does not: the Anycloud API reads its local activity database and
              sends the resulting message directly to Slack.
            </p>
            <div
              className={styles.flow}
              aria-label="Slack notification data flow"
            >
              <div className={styles.flowNode}>
                <span className={styles.flowLabel}>Your infrastructure</span>
                <strong>Anycloud API</strong>
                <span>
                  Calculates workload activity and compute spend locally.
                </span>
              </div>
              <div className={styles.flowNode}>
                <span className={styles.flowLabel}>Outbound HTTPS</span>
                <strong>Slack incoming webhook</strong>
                <span>
                  Uses the secret URL created for the channel you selected.
                </span>
              </div>
              <div className={styles.flowNode}>
                <span className={styles.flowLabel}>Your workspace</span>
                <strong>Selected Slack channel</strong>
                <span>
                  Receives only the alerts and summaries Anycloud sends.
                </span>
              </div>
            </div>
          </div>
        </section>

        <section className={`${styles.section} ${styles.sectionSoft}`}>
          <div className={styles.wrap}>
            <p className={styles.eyebrow}>Minimal permission</p>
            <h2 className={styles.sectionTitle}>Permission for one job only</h2>
            <div className={styles.permission}>
              <div>
                <p className={styles.exampleLabel}>Required Slack scope</p>
                <code className={styles.scope}>incoming-webhook</code>
              </div>
              <ul>
                <li>
                  Post messages to the channel selected during installation.
                </li>
                <li>
                  No permission to read messages, users, files, or channels.
                </li>
                <li>
                  No slash commands, events, interactive actions, or App Home.
                </li>
                <li>
                  No cloud-provider credentials pass through the Slack
                  installation service.
                </li>
              </ul>
            </div>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.wrap}>
            <p className={styles.eyebrow}>What your team sees</p>
            <h2 className={styles.sectionTitle}>
              Operational context without another dashboard
            </h2>
            <p className={styles.sectionIntro}>
              Messages are derived from the same local workload records used by
              the Anycloud CLI. Inactive sections and zero-value lines are
              omitted.
            </p>
            <div className={styles.examples}>
              <div>
                <p className={styles.exampleLabel}>Daily summary</p>
                <SlackSpendCapAlert
                  compact
                  title="anycloud: daily cloud activity"
                  lines={[
                    'Compute spend: $132.47',
                    '👤 alice',
                    '• Jobs: 18 completed · 2 preempted',
                    '👤 bob',
                    '• Services: $24.12 compute spend',
                  ]}
                />
              </div>
              <div>
                <p className={styles.exampleLabel}>Spend control</p>
                <SlackSpendCapAlert compact />
              </div>
            </div>
          </div>
        </section>

        <section className={`${styles.cta} ${styles.sectionSoft}`}>
          <div className={styles.wrap}>
            <p className={styles.eyebrow}>Ready to connect?</p>
            <h2 className={styles.sectionTitle}>Add Anycloud to Slack</h2>
            <p className={styles.sectionIntro}>
              The Slack integration has no separate charge. Your Anycloud plan
              and cloud-provider charges still apply.
            </p>
            <div className={styles.actions}>
              <a className={styles.primary} href={INSTALL_URL}>
                Add Anycloud to Slack
              </a>
              <Link className={styles.secondary} to="/slack/support/">
                Setup and support
              </Link>
              <Link className={styles.secondary} to="/slack/privacy/">
                Privacy
              </Link>
            </div>
          </div>
        </section>
      </main>
    </Layout>
  );
}
