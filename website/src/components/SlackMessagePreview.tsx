import React, { type ReactNode } from 'react';

import styles from './SlackMessagePreview.module.css';

type SlackMessagePreviewProps = {
  ariaLabel: string;
  bulleted?: boolean;
  compact?: boolean;
  lines: ReactNode[];
  source?: ReactNode;
  time?: string;
  title: ReactNode;
};

export default function SlackMessagePreview({
  ariaLabel,
  bulleted = false,
  compact = false,
  lines,
  source,
  time = '4:42 PM',
  title,
}: SlackMessagePreviewProps): ReactNode {
  return (
    <article
      className={`${styles.wrap} ${compact ? styles.compact : ''}`}
      aria-label={ariaLabel}
    >
      <div className={styles.messageRow}>
        <div className={styles.avatar} aria-hidden="true">
          <img
            className={styles.avatarGlyph}
            src="/img/cloud.png"
            alt=""
            width={22}
            height={15}
          />
        </div>
        <div className={styles.message}>
          <div className={styles.meta}>
            <span className={styles.name}>anycloud</span>
            <span className={styles.app}>APP</span>
            <span className={styles.time}>{time}</span>
          </div>
          <p className={styles.title}>{title}</p>
          {bulleted ? (
            <ul className={`${styles.lines} ${styles.bulletedLines}`}>
              {lines.map((line, index) => (
                <li key={index}>
                  <span className={styles.bullet} aria-hidden="true">
                    •
                  </span>
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className={styles.lines}>
              {lines.map((line, index) => (
                <span key={index}>{line}</span>
              ))}
            </div>
          )}
          {source ? <p className={styles.source}>{source}</p> : null}
        </div>
      </div>
    </article>
  );
}
