import React from 'react';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';

import styles from './slack.module.css';

export default function SlackSupport(): React.ReactElement {
  return (
    <Layout
      title="Slack app support"
      description="Install, test, troubleshoot, disable, or uninstall the Anycloud Slack integration."
    >
      <main className={styles.page}>
        <header className={styles.legalHero}>
          <div className={styles.wrap}>
            <p className={styles.eyebrow}>Anycloud for Slack</p>
            <h1 className={styles.legalTitle}>Setup and support</h1>
            <p className={styles.legalMeta}>
              Direct support without another account or support portal.
            </p>
          </div>
        </header>

        <div className={`${styles.wrap} ${styles.legal}`}>
          <section className={styles.contactCard}>
            <h2>Contact Anycloud</h2>
            <p>
              Email <a href="mailto:support@anycloud.sh">support@anycloud.sh</a>{' '}
              with a description of the issue and your Anycloud version. Do not
              include your webhook URL.
            </p>
            <p>We respond to support requests within two business days.</p>
          </section>

          <section>
            <h2>Install and connect</h2>
            <ol>
              <li>
                Run <code>anycloud notifications connect slack</code> on the
                machine hosting the Anycloud API. The CLI opens the Slack
                installation page or prints its URL.
              </li>
              <li>
                Choose the Slack workspace and channel that should receive
                operational alerts, then authorize the single requested
                permission.
              </li>
              <li>
                Click <strong>Copy webhook</strong>, return to the waiting
                terminal, and paste it into the hidden prompt.
              </li>
              <li>Confirm the test message appears in the selected channel.</li>
            </ol>
            <p className={styles.notice}>
              The Slack webhook is a secret. Paste it only into the Anycloud
              prompt on the intended server—not into tickets, chat, logs, or
              source control.
            </p>
          </section>

          <section>
            <h2>Check or test the integration</h2>
            <code className={styles.command}>
              anycloud notifications status
            </code>
            <code className={styles.command}>
              anycloud notifications test slack
            </code>
            <p>
              The Anycloud API checks for digest work every 15 minutes. Daily
              summaries cover the previous UTC calendar day and are sent only
              when there is relevant activity. The first check after enabling
              establishes a starting point instead of sending an incomplete
              historical digest.
            </p>
          </section>

          <section>
            <h2>Troubleshooting</h2>
            <h3>The CLI says the webhook is invalid</h3>
            <p>
              Start the installation again and copy the new webhook in full.
              Ensure it has not been modified by a password manager or messaging
              application.
            </p>

            <h3>The test message fails</h3>
            <p>
              Confirm the server has outbound HTTPS access to{' '}
              <code>hooks.slack.com</code>. If the channel was archived, the app
              was removed, or the webhook was revoked, reinstall the app and run{' '}
              <code>anycloud notifications enable slack</code> with the new
              webhook.
            </p>

            <h3>No daily summary appeared</h3>
            <p>
              Run <code>anycloud notifications status</code> and confirm the
              Anycloud API is running continuously. Summaries are skipped when
              there is no relevant activity, and the schedule uses UTC rather
              than the workspace&apos;s local timezone.
            </p>

            <h3>The webhook may have leaked</h3>
            <p>
              Uninstall the app from the affected Slack workspace or remove the
              webhook in Slack immediately. Reinstall to generate a replacement,
              then update the Anycloud server.
            </p>
          </section>

          <section>
            <h2>Disable or uninstall</h2>
            <p>To stop delivery and remove the stored webhook:</p>
            <code className={styles.command}>
              anycloud notifications disable slack
            </code>
            <p>
              A Slack workspace administrator can then uninstall Anycloud from
              Slack&apos;s app-management settings, which revokes the incoming
              webhook. Disabling notifications does not uninstall the Slack app,
              and uninstalling the Slack app does not remove the webhook stored
              on your API.
            </p>
          </section>

          <section>
            <h2>More information</h2>
            <ul>
              <li>
                <Link to="/platform/notifications/">
                  Notification behavior and digest contents
                </Link>
              </li>
              <li>
                <Link to="/reference/cli/notifications/">
                  Notifications CLI reference
                </Link>
              </li>
              <li>
                <Link to="/slack/privacy/">Slack app privacy policy</Link>
              </li>
            </ul>
          </section>
        </div>
      </main>
    </Layout>
  );
}
