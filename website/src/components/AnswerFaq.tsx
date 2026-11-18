import React from 'react';

import styles from './AnswerFaq.module.css';

type AnswerFaqProps = {
  children: React.ReactNode;
  title?: string;
};

type AnswerFaqItemProps = {
  children: React.ReactNode;
  question: string;
  open?: boolean;
};

function AnswerFaqBase({
  children,
  title = 'Related questions',
}: AnswerFaqProps) {
  return (
    <section className={styles.faq} aria-labelledby="answer-faq-title">
      <h2 id="answer-faq-title" className={styles.title}>
        {title}
      </h2>
      <div className={styles.list}>{children}</div>
    </section>
  );
}

function AnswerFaqItem({ children, question, open }: AnswerFaqItemProps) {
  return (
    <details className={styles.item} open={open}>
      <summary className={styles.question}>{question}</summary>
      <div className={styles.answer}>{children}</div>
    </details>
  );
}

const AnswerFaq = Object.assign(AnswerFaqBase, {
  Item: AnswerFaqItem,
});

export default AnswerFaq;
