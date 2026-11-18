import React, { type ReactNode } from 'react';
import Head from '@docusaurus/Head';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import { useLocation } from '@docusaurus/router';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';

import AnswerFaq from './AnswerFaq';
import styles from './HelpAnswer.module.css';

export type HelpSource = {
  label: string;
  href: string;
};

export type HelpRelated = {
  title: string;
  href: string;
};

export type HelpFaq = {
  question: string;
  answer: string;
};

type HelpAnswerProps = {
  children: ReactNode;
  // 'YYYY-MM-DD'; bump dateModified whenever the article copy changes.
  dateModified: string;
  datePublished: string;
  description: string;
  faqs: HelpFaq[];
  related?: HelpRelated[];
  sources: HelpSource[];
  title: string;
};

const ORG_ID = 'https://anycloud.sh/#org';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function formatMonthYear(isoDate: string) {
  const [year, month] = isoDate.split('-');
  return `${MONTHS[Number(month) - 1]} ${year}`;
}

export function HelpAnswer({
  children,
  dateModified,
  datePublished,
  description,
  faqs,
  related = [],
  sources,
  title,
}: HelpAnswerProps) {
  const { siteConfig } = useDocusaurusContext();
  const { pathname } = useLocation();
  const pageUrl = `${siteConfig.url}${pathname}`;
  const structuredData = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': ORG_ID,
        name: 'anycloud',
        url: 'https://anycloud.sh',
        logo: 'https://anycloud.sh/img/og-image.png',
      },
      {
        '@type': 'TechArticle',
        headline: title,
        description,
        datePublished,
        dateModified,
        url: pageUrl,
        mainEntityOfPage: pageUrl,
        author: { '@id': ORG_ID },
        publisher: { '@id': ORG_ID },
      },
      {
        '@type': 'FAQPage',
        mainEntity: faqs.map((faq) => ({
          '@type': 'Question',
          name: faq.question,
          acceptedAnswer: { '@type': 'Answer', text: faq.answer },
        })),
      },
    ],
  };

  return (
    <Layout title={title} description={description}>
      <Head>
        <script type="application/ld+json">
          {JSON.stringify(structuredData)}
        </script>
      </Head>
      <main className={styles.page}>
        <section className={styles.hero}>
          <div className={`${styles.wrap} ${styles.narrow}`}>
            <Link to="/help/" className={styles.backLink}>
              Help
            </Link>
            <h1 className={styles.title}>{title}</h1>
            <p className={styles.updated}>
              Updated {formatMonthYear(dateModified)}
            </p>
          </div>
        </section>

        <div className={`${styles.wrap} ${styles.narrow} ${styles.body}`}>
          <article className={styles.article}>
            {children}

            <section id="related-questions">
              <AnswerFaq>
                {faqs.map((faq) => (
                  <AnswerFaq.Item key={faq.question} question={faq.question}>
                    {faq.answer}
                  </AnswerFaq.Item>
                ))}
              </AnswerFaq>
            </section>

            <section className={styles.endSection}>
              <h2>Sources</h2>
              <ul className={styles.sourceList}>
                {sources.map((source) => (
                  <li key={source.href}>
                    <a href={source.href}>{source.label}</a>
                  </li>
                ))}
              </ul>
            </section>
          </article>

          {related.length > 0 && (
            <section className={styles.endSection}>
              <h2>Related answers</h2>
              <ul className={styles.relatedList}>
                {related.map((item) => (
                  <li key={item.href}>
                    <Link to={item.href}>{item.title}</Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </main>
    </Layout>
  );
}

type SectionProps = {
  children: ReactNode;
  title: string;
};

export function HelpSection({ children, title }: SectionProps) {
  return (
    <section id={slugify(title)} className={styles.section}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export function ShortAnswer({ children }: { children: ReactNode }) {
  return <div className={styles.shortAnswer}>{children}</div>;
}

export type FlowNode = {
  // The branch condition that leads into this box; omitted for the root.
  condition?: string;
  title: string;
  detail: string;
};

type DecisionFlowProps = {
  final: FlowNode;
  steps: Array<{ exit: FlowNode; question: FlowNode }>;
};

function FlowBox({ className, node }: { className: string; node: FlowNode }) {
  return (
    <div className={className}>
      {node.condition && (
        <span className={styles.flowChip}>{node.condition}</span>
      )}
      <strong className={styles.flowTitle}>{node.title}</strong>
      <span className={styles.flowDetail}>{node.detail}</span>
    </div>
  );
}

export function DecisionFlow({ final, steps }: DecisionFlowProps) {
  return (
    <figure className={styles.flow}>
      {steps.map((step) => (
        <React.Fragment key={step.question.title}>
          <FlowBox className={styles.flowQuestion} node={step.question} />
          <div className={styles.flowAcross} aria-hidden="true" />
          <FlowBox className={styles.flowLeaf} node={step.exit} />
          <div className={styles.flowDown} aria-hidden="true" />
        </React.Fragment>
      ))}
      <FlowBox
        className={`${styles.flowLeaf} ${styles.flowEnd}`}
        node={final}
      />
    </figure>
  );
}

export function CheckList({ children }: { children: ReactNode }) {
  return <ul className={styles.checkList}>{children}</ul>;
}

export function PlainList({ children }: { children: ReactNode }) {
  return <ul className={styles.plainList}>{children}</ul>;
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
