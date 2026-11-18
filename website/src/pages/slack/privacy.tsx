import React from 'react';
import Layout from '@theme/Layout';

import styles from './slack.module.css';

export default function SlackPrivacy(): React.ReactElement {
  return (
    <Layout
      title="Slack app privacy policy"
      description="How the Anycloud Slack app handles installation credentials, webhook URLs, local workload information, and Slack messages."
    >
      <main className={styles.page}>
        <header className={styles.legalHero}>
          <div className={styles.wrap}>
            <p className={styles.eyebrow}>Anycloud for Slack</p>
            <h1 className={styles.legalTitle}>Privacy policy</h1>
            <p className={styles.legalMeta}>Effective August 21, 2026</p>
          </div>
        </header>

        <div className={`${styles.wrap} ${styles.legal}`}>
          <p className={styles.notice}>
            Anycloud uses a local-delivery architecture. The installation
            service creates a Slack incoming webhook, but it does not receive or
            relay your ongoing notifications and does not read Slack data.
          </p>

          <section>
            <h2>Information handled during installation</h2>
            <p>
              When an administrator installs Anycloud, Slack redirects the
              browser to our OAuth callback with a short-lived authorization
              code and state value. Our Cloudflare Worker exchanges that code
              with Slack and receives installation metadata, an OAuth access
              token, and the incoming webhook URL for the selected channel.
            </p>
            <p>
              The Worker uses only the webhook URL to render a protected copy
              control. It does not persist the authorization code, OAuth access
              token, workspace metadata, or webhook URL. The OAuth access token
              is discarded immediately. The callback does not use application
              analytics, and its responses are marked as non-cacheable.
            </p>
          </section>

          <section>
            <h2>Information stored on your Anycloud server</h2>
            <p>
              After an operator pastes the webhook into the hidden CLI prompt,
              the CLI hands it to the Anycloud API that will send the
              notifications. That API stores the incoming webhook URL in its own
              database, encrypted at rest with the same key it uses for cloud
              credentials and secrets. It remains there until an operator
              disables Slack notifications.
            </p>
            <p>
              The Anycloud API reads workload activity and compute-spend
              information from its local database to create daily summaries and
              spend-cap alerts. It sends the resulting message directly to the
              selected Slack channel. Cloud-provider credentials are not
              included in these messages or sent to the installation service.
            </p>
          </section>

          <section>
            <h2>Slack data we do not collect</h2>
            <p>
              The app requests only Slack&apos;s <code>incoming-webhook</code>{' '}
              permission. It cannot read channel history, messages, users,
              files, reactions, or workspace directories. It does not subscribe
              to Slack events or use Slack content to train machine-learning
              models.
            </p>
          </section>

          <section>
            <h2>Retention and service providers</h2>
            <ul>
              <li>
                OAuth and webhook values exist in Worker memory only for the
                duration of the installation request and are not retained by the
                Anycloud application.
              </li>
              <li>
                Cloudflare processes network requests as our hosting and
                security provider. Worker application logging and observability
                are disabled for the OAuth flow.
              </li>
              <li>
                Slack receives and retains messages according to the installed
                workspace&apos;s Slack plan, settings, and retention policy.
              </li>
              <li>
                The public pages on <code>anycloud.sh</code> use the
                website&apos;s standard analytics. Those pages do not receive
                OAuth codes or webhook URLs, which are handled on the separate{' '}
                <code>slack.anycloud.sh</code> callback.
              </li>
            </ul>
          </section>

          <section>
            <h2>Access, transfer, and deletion</h2>
            <p>
              Anycloud does not maintain a hosted account or dataset containing
              Slack workspace content for this integration. A server operator
              can inspect or remove the stored configuration at any time:
            </p>
            <code className={styles.command}>
              anycloud notifications disable slack
            </code>
            <p>
              A Slack administrator can uninstall Anycloud to revoke the
              workspace installation and its webhook. To request information,
              assistance with deletion, or a transfer of any data you believe
              Anycloud holds, email{' '}
              <a href="mailto:support@anycloud.sh">support@anycloud.sh</a>.
            </p>
          </section>

          <section>
            <h2>Security</h2>
            <p>
              Treat the webhook URL as a secret. Never commit it to source
              control or include it in support messages. Anycloud uses TLS for
              the OAuth flow and webhook delivery, validates the Slack webhook
              host, protects the OAuth flow with a short-lived state cookie,
              keeps terminal input hidden, and does not place the webhook URL in
              a browser URL.
            </p>
          </section>

          <section>
            <h2>Changes and contact</h2>
            <p>
              We may update this policy when the integration changes. The
              effective date above will identify the latest version. Questions
              and privacy requests can be sent to{' '}
              <a href="mailto:support@anycloud.sh">support@anycloud.sh</a>.
            </p>
          </section>
        </div>
      </main>
    </Layout>
  );
}
