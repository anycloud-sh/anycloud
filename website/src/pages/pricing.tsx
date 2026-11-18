import React from 'react';
import clsx from 'clsx';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import shared from './index.module.css';
import styles from './pricing.module.css';

function Check() {
  return (
    <svg
      className={styles.tierCheck}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M3 8.5L6.5 12L13 4.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

type Tier = {
  name: string;
  price: string;
  priceUnit?: string;
  qualifier: string;
  items: string[];
  cta: { label: string; href: string; primary: boolean };
};

// Sentinel resolved to the community Slack invite (customFields.slackInviteUrl) at render.
const SLACK_CTA_HREF = '#slack';

const TIERS: Tier[] = [
  {
    name: 'Free',
    price: '$0',
    priceUnit: '/ month',
    qualifier: 'For teams spending under $1,000/month on cloud compute.',
    items: [
      'AWS, Azure, GCP, Lambda',
      'Any region, any GPU',
      'Spot recovery built in',
      'Python SDK and CLI',
    ],
    cta: { label: 'Get Started', href: '/getting-started', primary: true },
  },
  {
    name: 'Custom',
    price: "Let's talk",
    qualifier: 'For teams spending more than $1,000/month on cloud compute.',
    items: [
      'Everything in Free',
      'Slack cloud cost notifications',
      'Budgets and spend controls',
      'Premium support',
    ],
    cta: {
      label: 'Talk to Us',
      href: SLACK_CTA_HREF,
      primary: false,
    },
  },
];

function TierCta({ cta }: { cta: Tier['cta'] }) {
  const className = clsx(
    shared.btn,
    cta.primary ? shared.btnPrimary : shared.btnGhost,
    styles.tierCta,
  );
  if (cta.href.startsWith('mailto:') || cta.href.startsWith('http')) {
    return (
      <a href={cta.href} className={className}>
        {cta.label}
      </a>
    );
  }
  return (
    <Link to={cta.href} className={className}>
      {cta.label} <span className={shared.arrow}>→</span>
    </Link>
  );
}

export default function Pricing(): React.ReactElement {
  const { siteConfig } = useDocusaurusContext();
  const slackInviteUrl = siteConfig.customFields?.slackInviteUrl;
  const resolveCta = (cta: Tier['cta']): Tier['cta'] =>
    cta.href === SLACK_CTA_HREF && typeof slackInviteUrl === 'string'
      ? { ...cta, href: slackInviteUrl }
      : cta;

  return (
    <Layout
      title="Pricing"
      description="anycloud is free for teams spending under $1,000/month on cloud compute. For larger workloads, talk to us."
    >
      <div className={shared.page}>
        <section className={shared.section}>
          <div className={shared.wrap}>
            <p className={shared.eyebrow}>Pricing</p>
            <h1 className={shared.sectionTitle}>
              Start free. Talk to us at scale
            </h1>
            <p className={shared.sectionSub}>
              anycloud is free while your team spends under $1,000/month on
              cloud compute. Above that, get in touch and we&apos;ll put
              together pricing that fits your usage.
            </p>

            <div className={styles.tiers}>
              {TIERS.map((tier) => (
                <article key={tier.name} className={styles.tier}>
                  <p className={styles.tierName}>{tier.name}</p>
                  <p className={styles.tierPrice}>
                    {tier.price}
                    {tier.priceUnit && (
                      <span className={styles.tierPriceUnit}>
                        {tier.priceUnit}
                      </span>
                    )}
                  </p>
                  <p className={styles.tierQualifier}>{tier.qualifier}</p>
                  <ul className={styles.tierList}>
                    {tier.items.map((item) => (
                      <li key={item} className={styles.tierItem}>
                        <Check />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                  <TierCta cta={resolveCta(tier.cta)} />
                </article>
              ))}
            </div>
          </div>
        </section>
      </div>
    </Layout>
  );
}
