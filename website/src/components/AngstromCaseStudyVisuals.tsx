import React, { useEffect, useRef, useState, type ReactNode } from 'react';

import SessionSpendCaps from './SessionSpendCaps';
import SlackSpendCapAlert from './SlackSpendCapAlert';
import styles from './AngstromCaseStudyVisuals.module.css';

type CarouselSlide = {
  key: string;
  label: string;
  content: ReactNode;
};

type SpendControlExplainer = {
  key: 'throttle' | 'budget';
  eyebrow: string;
  title: string;
  facts: Array<{ label: string; value: string }>;
};

const SPEND_CONTROL_EXPLAINERS: SpendControlExplainer[] = [
  {
    key: 'throttle',
    eyebrow: 'Throttle',
    title: 'Limits live burn rate',
    facts: [
      { label: 'Measures', value: 'estimated live $/hr' },
      { label: 'Blocks at', value: 'running + next VM >= cap' },
      { label: 'Clears', value: 'when running VMs finish' },
    ],
  },
  {
    key: 'budget',
    eyebrow: 'Budget',
    title: 'Limits total spend',
    facts: [
      { label: 'Measures', value: 'settled + estimated spend' },
      { label: 'Blocks at', value: 'period spend >= cap' },
      { label: 'Clears', value: 'at UTC reset' },
    ],
  },
];

function VisualCarousel({
  ariaLabel,
  slides,
}: {
  ariaLabel: string;
  slides: CarouselSlide[];
}): ReactNode {
  const [active, setActive] = useState(0);
  const trackRef = useRef<HTMLDivElement>(null);
  const [viewportHeight, setViewportHeight] = useState<number | undefined>();

  useEffect(() => {
    const slide = trackRef.current?.children[active] as HTMLElement | undefined;
    if (!slide) return undefined;

    const measure = () => setViewportHeight(slide.offsetHeight);
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(slide);
    return () => observer.disconnect();
  }, [active]);

  const previous = () =>
    setActive((current) => (current + slides.length - 1) % slides.length);
  const next = () => setActive((current) => (current + 1) % slides.length);

  return (
    <div
      className={styles.carousel}
      role="region"
      aria-roledescription="carousel"
      aria-label={ariaLabel}
    >
      <div className={styles.viewport} style={{ height: viewportHeight }}>
        <div
          ref={trackRef}
          className={styles.track}
          style={{ transform: `translateX(-${active * 100}%)` }}
        >
          {slides.map((slide, index) => (
            <div
              className={styles.slide}
              key={slide.key}
              role="group"
              aria-roledescription="slide"
              aria-label={`${index + 1} of ${slides.length}: ${slide.label}`}
              aria-hidden={active !== index}
            >
              {slide.content}
            </div>
          ))}
        </div>
      </div>

      <div className={styles.controls}>
        <button
          type="button"
          className={styles.button}
          onClick={previous}
          aria-label="Previous visual"
          title="Previous"
        >
          ‹
        </button>
        <div className={styles.dots}>
          {slides.map((slide, index) => (
            <button
              type="button"
              key={slide.key}
              className={`${styles.dot} ${
                active === index ? styles.dotActive : ''
              }`}
              onClick={() => setActive(index)}
              aria-label={`Show ${slide.label}`}
              aria-current={active === index ? 'true' : undefined}
              title={slide.label}
            />
          ))}
        </div>
        <button
          type="button"
          className={styles.button}
          onClick={next}
          aria-label="Next visual"
          title="Next"
        >
          ›
        </button>
      </div>
    </div>
  );
}

function SlackDailyDigest(): ReactNode {
  return (
    <div className={styles.slackWrap} aria-label="Example Slack daily digest">
      <div className={styles.slackMessageRow}>
        <div className={styles.slackAvatar} aria-hidden="true">
          <img
            className={styles.slackAvatarGlyph}
            src="/img/cloud.png"
            alt=""
            width={24}
            height={16}
          />
        </div>
        <div className={styles.slackMessage}>
          <div className={styles.slackMeta}>
            <span className={styles.slackName}>anycloud</span>
            <span className={styles.slackApp}>APP</span>
            <span className={styles.slackTime}>9:00 AM</span>
          </div>
          <p className={`${styles.slackTitle} ${styles.digestTitle}`}>
            anycloud usage on 2026-10-04 (UTC)
          </p>
          <div className={styles.digestLines}>
            <span>💰 Compute spend: $412.80 (est.)</span>
            <span className={styles.digestSection}>
              👤 angstrom
              <br />
              📦 Jobs — $412.80 (est.) · 1,184.0h across 236 provisioned VM
              attempts
            </span>
            <span className={styles.digestSubline}>
              • 🚀 214 initial submissions
            </span>
            <span className={styles.digestSubline}>• 🔁 22 resubmissions</span>
            <span className={styles.digestSubline}>• 🏁 206 ended</span>
            <span className={styles.digestDetail}>
              ◦ ✅ 198 completed · ❌ 3 failed · ⚠️ 1 errored · ⏹️ 4 terminated
            </span>
            <span className={styles.digestDetail}>
              ◦ ⚡ 19 were preempted at least once during their run (9%)
            </span>
            <span className={styles.digestDetail}>
              ◦ ⏱️ Median duration: 4.8h
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function SpendControlsCarousel(): ReactNode {
  return (
    <div
      className={styles.spendExplainers}
      aria-label="Spend controls examples"
    >
      {SPEND_CONTROL_EXPLAINERS.map((item) => (
        <article className={styles.spendExplainer} key={item.key}>
          <div className={styles.spendCopy}>
            <p className={styles.spendEyebrow}>{item.eyebrow}</p>
            <h3 className={styles.spendTitle}>{item.title}</h3>
            <dl className={styles.spendFacts}>
              {item.facts.map((fact) => (
                <div className={styles.spendFact} key={fact.label}>
                  <dt>{fact.label}</dt>
                  <dd>{fact.value}</dd>
                </div>
              ))}
            </dl>
          </div>
          <SessionSpendCaps
            compact
            mode={item.key === 'throttle' ? 'throttle' : 'budget'}
          />
        </article>
      ))}
    </div>
  );
}

export function SlackNotificationsCarousel(): ReactNode {
  return (
    <VisualCarousel
      ariaLabel="Slack notification examples"
      slides={[
        {
          key: 'digest',
          label: 'Daily digest',
          content: <SlackDailyDigest />,
        },
        {
          key: 'cap-alert',
          label: 'Cap-hit alert',
          content: <SlackSpendCapAlert compact />,
        },
      ]}
    />
  );
}
