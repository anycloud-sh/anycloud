import React, { useEffect, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import Head from '@docusaurus/Head';
import Emoji from '../components/Emoji';
import LaunchVideo from '../components/LaunchVideo';
import PreemptionRecovery from '../components/PreemptionRecovery';
import styles from './index.module.css';

const STRUCTURED_DATA = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'Organization',
      '@id': 'https://anycloud.sh/#org',
      name: 'anycloud',
      url: 'https://anycloud.sh',
      logo: 'https://anycloud.sh/img/og-image.png',
    },
    {
      '@type': 'SoftwareApplication',
      name: 'anycloud',
      operatingSystem: 'macOS, Linux',
      applicationCategory: 'DeveloperApplication',
      description:
        'The CLI for people and AI agents to run jobs, Kubernetes Deployments, and VMs across connected cloud accounts.',
      url: 'https://anycloud.sh',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      publisher: { '@id': 'https://anycloud.sh/#org' },
    },
  ],
};

// Drifting hero-background emojis — rendered as native OS glyphs (Apple Color
// Emoji on Mac/iOS, Segoe on Windows, etc.). Includes the workload lifecycle
// from src/shared/workload.ts (positive states only).
const HERO_EMOJIS = [
  '☁️',
  '🐳',
  '🔑',
  '📦',
  '🔒',
  '🏷️',
  '🏗️',
  '⚙️',
  '📥',
  '💾',
  '🚀',
  '🔁',
  '⚡',
  '✅',
];
const AGENT_SETUP_PROMPT = 'set up https://anycloud.sh/SKILL.md';
const SPOT_JOB_CMD = 'anycloud job --gpu-type h100 --spot';

type WorkloadMode = {
  id: string;
  label: string;
  icon: string;
  command: string;
  summary: string;
  goodFor: string;
  docsHref: string;
};

// Every homepage surface that enumerates workload modes reads from this one
// registry, so future modes only require another entry here.
const WORKLOAD_MODES: readonly WorkloadMode[] = [
  {
    id: 'job',
    label: 'Job',
    icon: '🏁',
    command: 'anycloud job',
    summary: 'Run finite work to completion.',
    goodFor:
      'Model training, evaluations, batch inference, and data processing.',
    docsHref: '/platform/jobs',
  },
  {
    id: 'deployment',
    label: 'Deployment',
    icon: '🌐',
    command: 'anycloud deployment',
    summary: 'Keep an application running on Kubernetes for Jobs to target.',
    goodFor:
      'Warm model servers and inference workers that run many short Jobs.',
    docsHref: '/reference/cli/deployments',
  },
  {
    id: 'vm',
    label: 'VM',
    icon: '🖥️',
    command: 'anycloud vm',
    summary: 'Work directly with provisioned compute.',
    goodFor:
      'Interactive exploration, debugging, and custom research workflows.',
    docsHref: '/platform/vms',
  },
];

// --- Drifting hero background --------------------------------------------
function HeroEmojis() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = ref.current;
    if (!box) return;
    box.innerHTML = '';
    const frag = document.createDocumentFragment();
    const count = HERO_EMOJIS.length;
    for (let i = 0; i < count; i++) {
      const s = document.createElement('span');
      s.textContent = HERO_EMOJIS[i % count];
      s.style.left = Math.random() * 100 + '%';
      const dur = 28 + Math.random() * 17;
      s.style.setProperty('--dur', dur + 's');
      // Even stagger so coverage stays constant instead of clumping
      s.style.animationDelay = -(i / count) * dur + 's';
      const sz = 18 + Math.random() * 24;
      s.style.fontSize = sz + 'px';
      frag.appendChild(s);
    }
    box.appendChild(frag);
  }, []);
  return <div ref={ref} className={styles.heroEmojis} aria-hidden="true" />;
}

// --- Hero terminal: agent setup prompt + workload command stack -----------
function HeroTerminal() {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(AGENT_SETUP_PROMPT);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch (_) {}
  };

  return (
    <div className={clsx(styles.install, styles.terminal)}>
      <div className={styles.termHint}>
        # Paste into Claude Code, Codex, or another coding agent
      </div>
      <div className={styles.termRow}>
        <span className={styles.prompt}>›</span>
        <code>{AGENT_SETUP_PROMPT}</code>
        <button
          type="button"
          className={clsx(styles.copyBtn, copied && styles.copied)}
          onClick={copy}
          aria-label="Copy agent setup prompt"
        >
          {copied ? '✓' : '⧉'}
        </button>
      </div>
      <div className={styles.terminalDivider} aria-hidden="true" />
      {WORKLOAD_MODES.map((mode) => (
        <div key={mode.id} className={styles.heroCommandRow}>
          <span className={styles.prompt}>$</span>
          <Emoji className={styles.heroCommandEmoji} aria-hidden size={16}>
            {mode.icon}
          </Emoji>
          <code>{mode.command}</code>
          <span className={styles.heroCommandSummary}>{mode.goodFor}</span>
        </div>
      ))}
    </div>
  );
}

// --- HERO -----------------------------------------------------------------
function Hero() {
  return (
    <header className={styles.hero}>
      <div className={styles.wrap}>
        <p className={styles.heroEyebrow}>For agents</p>
        <h1 className={styles.h1}>
          CLI for any AI workload in any cloud account
        </h1>

        <p className={styles.lede}>
          Guardrails let agents safely run jobs, create Kubernetes Deployments,
          and launch VMs on CPU and GPU infrastructure.
        </p>

        <HeroTerminal />

        <div className={styles.heroCta}>
          <Link
            to="/getting-started"
            className={clsx(styles.btn, styles.btnPrimary)}
          >
            Get Started <span className={styles.arrow}>→</span>
          </Link>
          <Link
            to="/getting-started"
            className={clsx(styles.btn, styles.btnGhost)}
          >
            Read the Docs
          </Link>
        </div>

        <LaunchVideo />
      </div>
    </header>
  );
}

// --- CLOUD LOGOS (simplified brand marks) --------------------------------
function CloudLogo({ name }: { name: 'aws' | 'azure' | 'gcp' | 'lambda' }) {
  if (name === 'aws') {
    return (
      <svg
        viewBox="0 0 44 28"
        width="40"
        height="26"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <text
          x="22"
          y="16"
          fontFamily="Inter, -apple-system, BlinkMacSystemFont, system-ui, sans-serif"
          fontSize="15"
          fontWeight="800"
          fill="#FF9900"
          textAnchor="middle"
          letterSpacing="-0.6"
        >
          aws
        </text>
        <path
          d="M6 22 Q 22 27 38 22"
          stroke="#FF9900"
          strokeWidth="2"
          fill="none"
          strokeLinecap="round"
        />
        <path
          d="M37 23 L 39 22 L 38 24.2"
          stroke="#FF9900"
          strokeWidth="2"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (name === 'azure') {
    return (
      <svg
        viewBox="0 0 30 28"
        width="28"
        height="26"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="anycloudAzGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#50B0F0" />
            <stop offset="100%" stopColor="#0078D4" />
          </linearGradient>
        </defs>
        <path
          d="M11 4 L19 4 L28 25 L18 25 L15 18 L12 25 L2 25 Z"
          fill="url(#anycloudAzGrad)"
        />
        <path d="M15 10 L19 10 L16 18 L13 18 Z" fill="#003A7A" opacity="0.28" />
      </svg>
    );
  }

  if (name === 'gcp') {
    return (
      <svg
        viewBox="0 0 32 32"
        width="28"
        height="28"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <g
          transform="translate(16 16)"
          fill="none"
          strokeWidth="5"
          strokeLinecap="round"
        >
          <path d="M 0 -12 A 12 12 0 0 1 11.4 4" stroke="#4285F4" />
          <path d="M 11.4 4 A 12 12 0 0 1 0 12" stroke="#34A853" />
          <path d="M 0 12 A 12 12 0 0 1 -11.4 4" stroke="#FBBC04" />
          <path d="M -11.4 4 A 12 12 0 0 1 0 -12" stroke="#EA4335" />
        </g>
      </svg>
    );
  }

  // lambda
  return (
    <svg
      viewBox="0 0 22 28"
      width="20"
      height="26"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M4 5 L9 5 L18 25 L13.5 25 L11 19 L8 25 L3 25 L8.5 15 L6 8 Z"
        fill="#7C3AED"
      />
    </svg>
  );
}

function Clouds() {
  const items: Array<['aws' | 'azure' | 'gcp' | 'lambda', string]> = [
    ['aws', 'AWS'],
    ['azure', 'Azure'],
    ['gcp', 'GCP'],
    ['lambda', 'Lambda'],
  ];
  return (
    <section className={styles.clouds}>
      <div className={styles.wrap}>
        <div className={styles.cloudsLabel}>
          One CLI across the cloud accounts you already use
        </div>
        <div className={styles.cloudRow}>
          {items.map(([key, name]) => (
            <span key={key} className={styles.cloud}>
              <span className={styles.cloudE}>
                <CloudLogo name={key} />
              </span>
              {name}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

type ScanChip = {
  key: 'aws' | 'azure' | 'gcp' | 'lambda';
  name: string;
  price: string;
  best?: boolean;
};

// Spot markets move, so the highlighted provider changes with each
// illustrative scenario.
const SCAN_SCENARIOS: ScanChip[][] = [
  [
    { key: 'aws', name: 'AWS', price: '$2.12/hr' },
    { key: 'azure', name: 'Azure', price: '$1.64/hr', best: true },
    { key: 'gcp', name: 'GCP', price: '$2.38/hr' },
    { key: 'lambda', name: 'Lambda', price: '$1.79/hr' },
  ],
  [
    { key: 'aws', name: 'AWS', price: '$2.08/hr' },
    { key: 'azure', name: 'Azure', price: '$2.01/hr' },
    { key: 'gcp', name: 'GCP', price: '$2.24/hr' },
    { key: 'lambda', name: 'Lambda', price: '$1.71/hr', best: true },
  ],
  [
    { key: 'aws', name: 'AWS', price: '$1.69/hr', best: true },
    { key: 'azure', name: 'Azure', price: '$2.05/hr' },
    { key: 'gcp', name: 'GCP', price: '$2.31/hr' },
    { key: 'lambda', name: 'Lambda', price: '$1.84/hr' },
  ],
];

function ScanDiagram() {
  const [scene, setScene] = useState(0);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const id = setInterval(
      () => setScene((current) => (current + 1) % SCAN_SCENARIOS.length),
      3500,
    );
    return () => clearInterval(id);
  }, []);

  return (
    <div className={styles.scanDiagram}>
      <div className={styles.scanJob}>
        <Emoji aria-hidden size={16}>
          🚀
        </Emoji>
        <code>{SPOT_JOB_CMD}</code>
      </div>
      <span className={styles.scanStem} aria-hidden="true" />
      <ul className={styles.scanChips} aria-hidden="true">
        {SCAN_SCENARIOS[scene].map((cloud) => (
          <li
            key={cloud.key}
            className={clsx(styles.scanChip, cloud.best && styles.scanChipBest)}
          >
            <span className={styles.scanChipLogo}>
              <CloudLogo name={cloud.key} />
            </span>
            {cloud.name}
            <span className={styles.scanChipPrice}>{cloud.price}</span>
            {cloud.best && <span className={styles.scanBestTag}>✓</span>}
          </li>
        ))}
      </ul>
      <p className={styles.scanCaption}>
        For one job, the lowest price across every region in every account wins.
        Spot prices are illustrative.
      </p>
    </div>
  );
}

// --- WORKLOAD MODES + SHARED CAPABILITIES --------------------------------
type Feature = {
  emoji: string;
  anim: 'money' | 'bob' | 'tilt' | 'shake';
  title: string;
  body: ReactNode;
};

const SHARED_CAPABILITIES: Feature[] = [
  {
    emoji: '🧭',
    anim: 'tilt',
    title: 'Choose the account and hardware',
    body: (
      <>
        Pin a cloud account, region, or hardware profile—or let anycloud make a
        cost-aware choice from matching compute.
      </>
    ),
  },
  {
    emoji: '🐳',
    anim: 'bob',
    title: 'Bring your own container',
    body: (
      <>
        Use the same container image across workload modes, with the
        environment, secrets, and runtime settings each one needs.
      </>
    ),
  },
  {
    emoji: '🔐',
    anim: 'shake',
    title: 'Keep ownership in your accounts',
    body: (
      <>
        Your infrastructure, credentials, data, credits, and provider billing
        stay in the cloud accounts you control.
      </>
    ),
  },
];

const AGENT_CAPABILITIES: Feature[] = [
  {
    emoji: '🔁',
    anim: 'tilt',
    title: 'Keep the loop moving',
    body: (
      <>
        Agents can launch batches, read status and cost as JSON, retrieve
        results, and prepare outputs for the next decision using predictable
        commands.
      </>
    ),
  },
  {
    emoji: '🛡️',
    anim: 'shake',
    title:
      'Budgets, throttles and Slack alerts for each Claude Code and Codex session',
    body: (
      <>
        Scope budgets, burn-rate throttles, and alerts to each detected agent
        session. When a cap is reached, new jobs wait while running jobs finish.{' '}
        <Link to="/platform/spend-controls#agent-session-scope">
          Explore spend controls
        </Link>
        .
      </>
    ),
  },
];

function WorkloadModes() {
  return (
    <section id="workloads" className={styles.section}>
      <div className={styles.wrap}>
        <p className={styles.eyebrow}>Execution modes</p>
        <h2 className={styles.sectionTitle}>
          Choose the right primitive for any workload
        </h2>
        <p className={styles.sectionSub}>
          Run AI research as finite jobs, turn results into long-lived
          Kubernetes Deployments, or drop down to a VM for direct compute
          access—all behind the same cloud-account workflow.
        </p>

        <div className={styles.workloadGrid}>
          {WORKLOAD_MODES.map((mode) => (
            <article key={mode.id} className={styles.workloadCard}>
              <div className={styles.workloadCardTop}>
                <Emoji aria-hidden size={28}>
                  {mode.icon}
                </Emoji>
                <code>{mode.command}</code>
              </div>
              <h3 className={styles.workloadTitle}>{mode.label}</h3>
              <p className={styles.workloadSummary}>{mode.summary}</p>
              <dl className={styles.workloadGoodFor}>
                <dt>Good for</dt>
                <dd>{mode.goodFor}</dd>
              </dl>
              <Link className={styles.workloadLink} to={mode.docsHref}>
                Explore {mode.label}s <span aria-hidden="true">→</span>
              </Link>
            </article>
          ))}
        </div>
        <p className={styles.workloadSdkNote}>
          Prefer Python? Jobs and Kubernetes Deployments are also available
          through the <Link to="/reference/python-sdk">Python SDK</Link>.
        </p>
      </div>
    </section>
  );
}

function SlackPreviewMessage({
  time,
  title,
  lines,
  alert = false,
}: {
  time: string;
  title: ReactNode;
  lines: ReactNode[];
  alert?: boolean;
}) {
  return (
    <div className={clsx(styles.slackCard, alert && styles.slackAlert)}>
      <div className={styles.slackCardBar}>
        <img src="/img/slack-logo.svg" alt="" width={16} height={16} />
        <span className={styles.slackCardApp}>Slack</span>
        <span className={styles.slackCardChannel}>#training</span>
        <span className={styles.slackCardClose} aria-hidden="true">
          ×
        </span>
      </div>
      <div className={clsx(styles.slackMessageRow, styles.slackCardBody)}>
        <div className={styles.slackAvatar} aria-hidden="true">
          <img src="/img/cloud.png" alt="" width={24} height={16} />
        </div>
        <div className={styles.slackMessage}>
          <div className={styles.slackMeta}>
            <span className={styles.slackName}>anycloud</span>
            <span className={styles.slackApp}>APP</span>
            <span className={styles.slackTime}>{time}</span>
          </div>
          <p className={styles.slackTitle}>{title}</p>
          <div className={styles.slackLines}>
            {lines.map((line, index) => (
              <span key={index}>{line}</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function AgentLoopPreview() {
  return (
    <div className={styles.carouselCodeWrap}>
      <pre className={clsx(styles.codePane, styles.codePaneActive)}>
        <span className="com"># Set the limits for this agent session</span>
        {'\n'}
        <span className="snapDim">$</span> <span className="fn">anycloud</span>{' '}
        budget set <span className="num">200</span>{' '}
        <span className="flag">--per</span> day{' '}
        <span className="flag">--agent-session</span>
        {'\n\n'}
        <span className="com"># Launch the next batch</span>
        {'\n'}
        <span className="snapDim">$</span> <span className="fn">anycloud</span>{' '}
        job …{'\n\n'}
        <span className="com"># Check progress as JSON</span>
        {'\n'}
        <span className="snapDim">$</span> <span className="fn">anycloud</span>{' '}
        status <span className="str">&lt;job-id&gt;</span>{' '}
        <span className="flag">--json</span>
      </pre>
    </div>
  );
}

// --- anycloud spend snapshot (carousel slide) ----------------------------
// Mirrors the column layout and green/yellow/red thresholds of the
// `anycloud spend` output. Reimplemented here because the website is a
// separate build from the CLI.
const SPEND_LABEL_INDENT = 2;
const SPEND_SESSION_INDENT = 4;
const SPEND_LABEL_WIDTH = 20; // outer column for "account" / "claude:abc123"
const SPEND_BAR_WIDTH = 10;
const SPEND_PCT_WIDTH = 4;

function spendBar(percent: number): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * SPEND_BAR_WIDTH);
  return '█'.repeat(filled) + '░'.repeat(SPEND_BAR_WIDTH - filled);
}

function spendColor(percent: number): string {
  if (percent >= 90) return 'barRed';
  if (percent >= 70) return 'barYellow';
  return 'barGreen';
}

type SpendCell = {
  percent: number;
  current: string;
  cap: string;
  trailing: string;
};
type SpendAccount = SpendCell & { settled?: string };
type SpendSessionRow = SpendCell & { name: string };
type SpendSectionData = {
  heading: string;
  subhead: string;
  account: SpendAccount;
  perSession: { cap: string; rows: SpendSessionRow[] };
};
type SpendSnapshotData = {
  throttle: SpendSectionData;
  budget: SpendSectionData;
};

function spendRow(name: string, indent: number, cell: SpendCell): ReactNode {
  const label = (' '.repeat(indent) + name).padEnd(
    SPEND_LABEL_INDENT + SPEND_LABEL_WIDTH,
  );
  const cls = spendColor(cell.percent);
  const pctStr = `${Math.round(cell.percent)}`.padStart(2, ' ') + '%';
  return (
    <>
      {label}
      {'  '}
      <span className={cls}>{spendBar(cell.percent)}</span>
      {'  '}
      <span className={cls}>{pctStr}</span>
      {'  '}
      {cell.current.padStart(8)}
      {' / '}
      {cell.cap.padEnd(10)}
      {'  '}
      <span className="snapDim">{cell.trailing}</span>
    </>
  );
}

function spendSectionLines(
  section: SpendSectionData,
  mode: 'account' | 'session' | 'both' = 'both',
): ReactNode[] {
  const lines: ReactNode[] = [
    <>
      <span className="snapHead">{section.heading}</span>
      <span className="snapDim">{'  ' + section.subhead}</span>
    </>,
  ];
  if (mode !== 'session') {
    lines.push(spendRow('account', SPEND_LABEL_INDENT, section.account));
    if (section.account.settled) {
      const prefix = ' '.repeat(
        SPEND_LABEL_INDENT +
          SPEND_LABEL_WIDTH +
          2 +
          SPEND_BAR_WIDTH +
          2 +
          SPEND_PCT_WIDTH,
      );
      lines.push(
        <>
          {prefix}
          {'  '}
          <span className="snapDim">{section.account.settled}</span>
        </>,
      );
    }
  }
  if (mode !== 'account') {
    lines.push(
      <>
        {'  per agent-session'}
        <span className="snapDim">{'  ' + section.perSession.cap}</span>
      </>,
    );
    for (const r of section.perSession.rows) {
      lines.push(spendRow(r.name, SPEND_SESSION_INDENT, r));
    }
  }
  return lines;
}

const SPEND_SNAPSHOT_NEARCAP: SpendSnapshotData = {
  throttle: {
    heading: 'Throttle',
    subhead: '$/hr right now',
    account: {
      percent: 83,
      current: '$289.25',
      cap: '$350/hr',
      trailing: '$60.75/hr headroom',
    },
    perSession: {
      cap: 'cap $300/hr each',
      rows: [
        {
          name: 'train-llama-sft',
          percent: 96,
          current: '$289.25',
          cap: '$300/hr',
          trailing: '$10.75/hr headroom',
        },
      ],
    },
  },
  budget: {
    heading: 'Budget',
    subhead: 'day  (resets in 19h)',
    account: {
      percent: 8,
      current: '$402.65',
      cap: '$5,000',
      trailing: '$4,597.35 left',
      settled: '$0.00 settled · $402.65 estimate',
    },
    perSession: {
      cap: 'cap $4,000 each',
      rows: [
        {
          name: 'train-llama-sft',
          percent: 96,
          current: '$3,848',
          cap: '$4,000',
          trailing: '$152 left',
        },
        {
          name: 'lr-sweep',
          percent: 78,
          current: '$3,136',
          cap: '$4,000',
          trailing: '$864 left',
        },
        {
          name: 'eval-harness',
          percent: 9,
          current: '$368',
          cap: '$4,000',
          trailing: '$3,632 left',
        },
      ],
    },
  },
};

type CarouselSlide = { key: string; label: string; content: ReactNode };

function SlackPreviewCarousel({
  slides,
  ariaLabel,
}: {
  slides: CarouselSlide[];
  ariaLabel: string;
}) {
  const [active, setActive] = useState(0);
  const previous = () =>
    setActive((active + slides.length - 1) % slides.length);
  const next = () => setActive((active + 1) % slides.length);

  // Size the viewport to the active slide so shorter slides don't leave a gap.
  const trackRef = useRef<HTMLDivElement>(null);
  const [viewportHeight, setViewportHeight] = useState<number | undefined>(
    undefined,
  );
  useEffect(() => {
    const slide = trackRef.current?.children[active] as HTMLElement | undefined;
    if (!slide) return;
    const measure = () => setViewportHeight(slide.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(slide);
    return () => observer.disconnect();
  }, [active]);

  return (
    <div
      className={styles.slackPreview}
      role="region"
      aria-roledescription="carousel"
      aria-label={ariaLabel}
    >
      <div
        className={styles.slackCarouselViewport}
        style={{ height: viewportHeight }}
      >
        <div
          ref={trackRef}
          className={styles.slackCarouselTrack}
          style={{ transform: `translateX(-${active * 100}%)` }}
        >
          {slides.map((slide, index) => (
            <div
              key={slide.key}
              className={styles.slackSlide}
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

      <div className={styles.slackCarouselControls}>
        <button
          type="button"
          className={styles.slackCarouselButton}
          onClick={previous}
          aria-label="Previous spend controls example"
          title="Previous"
        >
          ‹
        </button>
        <div className={styles.slackCarouselDots}>
          {slides.map((slide, index) => (
            <button
              key={slide.key}
              type="button"
              className={clsx(
                styles.slackCarouselDot,
                active === index && styles.slackCarouselDotActive,
              )}
              onClick={() => setActive(index)}
              aria-label={`Show ${slide.label}`}
              aria-current={active === index ? 'true' : undefined}
              title={slide.label}
            />
          ))}
        </div>
        <button
          type="button"
          className={styles.slackCarouselButton}
          onClick={next}
          aria-label="Next spend controls example"
          title="Next"
        >
          ›
        </button>
      </div>
    </div>
  );
}

// One command → one table: set a per-session budget, see every session's burn.
function SessionCapsPreview() {
  const lines: ReactNode[] = [
    <>
      <span className="snapDim">$</span> <span className="fn">anycloud</span>{' '}
      budget set <span className="num">4000</span>{' '}
      <span className="flag">--per</span> day{' '}
      <span className="flag">--agent-session</span>
    </>,
    '',
    ...spendSectionLines(SPEND_SNAPSHOT_NEARCAP.budget, 'session'),
  ];
  return (
    <div className={styles.carouselCodeWrap}>
      <pre className={clsx(styles.codePane, styles.codePaneActive)}>
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

const SESSION_SPEND_SLIDES: CarouselSlide[] = [
  {
    key: 'sess-caps',
    label: 'Caps per session',
    content: <SessionCapsPreview />,
  },
  {
    key: 'agent-loop',
    label: 'Launch, monitor, repeat',
    content: <AgentLoopPreview />,
  },
  {
    key: 'cap-alert',
    label: 'Spend cap alert',
    content: (
      <SlackPreviewMessage
        alert
        time="4:42 PM"
        title="anycloud: workloads waiting on spend cap"
        lines={[
          <>
            blocked by daily budget (agent-session &apos;codex-riyadh&apos;):
            spent $4,224 / $4,000 — resumes 2026-05-29 00:00 UTC
          </>,
        ]}
      />
    ),
  },
];

function FeatureGrid({ items }: { items: Feature[] }) {
  return (
    <div className={styles.features}>
      {items.map((f) => (
        <article key={f.title} className={styles.feature}>
          <div
            className={clsx(styles.featureEmoji, styles[f.anim])}
            aria-hidden="true"
          >
            <Emoji aria-hidden size={28}>
              {f.emoji}
            </Emoji>
          </div>
          <h3 className={styles.featureH3}>{f.title}</h3>
          <p className={styles.featureP}>{f.body}</p>
        </article>
      ))}
    </div>
  );
}

function Capabilities() {
  return (
    <section
      id="capabilities"
      className={clsx(styles.section, styles.sectionSoft)}
    >
      <div className={styles.wrap}>
        <p className={styles.eyebrow}>Your cloud accounts</p>
        <h2 className={styles.sectionTitle}>Your cloud accounts stay yours.</h2>
        <p className={styles.sectionSub}>
          Choose where work runs while infrastructure, credentials, data,
          credits, and billing stay in your accounts.
        </p>
        <FeatureGrid items={SHARED_CAPABILITIES} />
        <div className={styles.capabilityScan}>
          <ScanDiagram />
        </div>
      </div>
    </section>
  );
}

// --- PRODUCTION / TESTIMONIAL --------------------------------------------
function Production() {
  return (
    <section
      id="production"
      className={clsx(styles.section, styles.sectionSoft)}
    >
      <div className={styles.wrap}>
        <p className={styles.eyebrow}>Agents in production</p>
        <h2 className={styles.sectionTitle}>
          Agent safeguards that accelerate the research loop.
        </h2>
        <p className={styles.sectionSub}>
          At Ångstrom AI, researchers chose the experiments and interpreted the
          results. Agents launched batches of jobs, monitored status, downloaded
          outputs, and generated plots and summaries for the next decision—all
          under per-session spend controls. The work spanned 100,000+ GPU hours.
        </p>

        <a
          href="https://x.com/SilkyDogfish"
          target="_blank"
          rel="noopener noreferrer"
          className={styles.testimonial}
        >
          <blockquote className={styles.testimonialQuote}>
            “We have been using anycloud at{' '}
            <span className={styles.testimonialHighlight}>@Angstrom_ai</span> to
            make the gpus go brrrrrr!”
          </blockquote>
          <div className={styles.testimonialAuthor}>
            <span className={styles.testimonialName}>Laurence Midgley</span>
            <span className={styles.testimonialDot}>·</span>
            <span className={styles.testimonialHandle}>@SilkyDogfish</span>
            <span className={styles.testimonialDot}>·</span>
            <span className={styles.testimonialCompany}>Angstrom AI</span>
          </div>
        </a>

        <Link to="/blog/angstrom-case-study" className={styles.caseStudyLink}>
          Read the Angstrom AI case study
        </Link>
      </div>
    </section>
  );
}

// --- AGENTS ---------------------------------------------------------------
function Agents() {
  return (
    <section id="agents" className={styles.section}>
      <div className={styles.wrap}>
        <p className={styles.eyebrow}>Agent guardrails</p>
        <h2 className={styles.sectionTitle}>
          Track and limit spend by agent session.
        </h2>
        <p className={styles.sectionSub}>
          Your team sets the research direction. Claude Code, Codex, Cursor, and
          Aider operate between decisions, while analytics, throttles, budgets,
          and alerts keep each agent session visible and bounded.
        </p>
        <FeatureGrid items={AGENT_CAPABILITIES} />
        <div className={styles.agentPreview}>
          <p className={styles.agentPreviewLabel}>
            Launch, monitor, repeat—with controls
          </p>
          <SlackPreviewCarousel
            slides={SESSION_SPEND_SLIDES}
            ariaLabel="agent command loop, per-session spend caps, and cap alerts"
          />
        </div>
      </div>
    </section>
  );
}

// --- SHARED WORKLOAD LIFECYCLE -------------------------------------------
function How() {
  const steps: Array<{ n: string; e: string; t: string; d: string }> = [
    {
      n: '01',
      e: '⌨️',
      t: 'Choose a mode',
      d: 'Start from the workload abstraction that fits.',
    },
    {
      n: '02',
      e: '🔑',
      t: 'Select an account',
      d: 'Choose credentials, region, and hardware.',
    },
    {
      n: '03',
      e: '🏗️',
      t: 'Provision',
      d: 'anycloud starts matching compute in that cloud account.',
    },
    {
      n: '04',
      e: '⚙️',
      t: 'Operate',
      d: 'Follow the workload through its mode-specific lifecycle.',
    },
    {
      n: '05',
      e: '🧹',
      t: 'Clean up',
      d: 'Release compute at completion or when you terminate the workload.',
    },
  ];
  return (
    <section id="how" className={styles.section}>
      <div className={styles.wrap}>
        <p className={styles.eyebrow}>How it works</p>
        <h2 className={styles.sectionTitle}>
          Any workflow, any cloud, any agent
        </h2>
        <p className={styles.sectionSub}>
          Run it yourself or hand it to an agent; anycloud follows the same path
          from cloud-account selection through provisioning, operation, and
          cleanup.
        </p>

        <ol className={styles.lifecycleFlow}>
          {steps.map((s, i) => (
            <li key={s.n} className={styles.lifecycleStep}>
              <div className={styles.lifecycleDotWrap}>
                <span className={styles.lifecycleDot} aria-hidden="true" />
                {i < steps.length - 1 && (
                  <span className={styles.lifecycleLine} aria-hidden="true" />
                )}
              </div>
              <div className={styles.lifecycleStepBody}>
                <div className={styles.lifecycleStepN}>{s.n}</div>
                <h3 className={styles.lifecycleStepTitle}>
                  <Emoji className={styles.lifecycleStepIcon} aria-hidden>
                    {s.e}
                  </Emoji>{' '}
                  {s.t}
                </h3>
                <p className={styles.lifecycleStepText}>{s.d}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

// --- OPTIONAL SPOT OPTIMIZATION ------------------------------------------
function SpotOptimization() {
  return (
    <section id="spot" className={clsx(styles.section, styles.sectionSoft)}>
      <div className={styles.wrap}>
        <p className={styles.eyebrow}>Optional cost optimization</p>
        <h2 className={styles.sectionTitle}>Spot saves up to 90%.</h2>
        <p className={styles.sectionSub}>
          <a href="https://aws.amazon.com/ec2/spot/">AWS</a> and{' '}
          <a href="https://azure.microsoft.com/en-us/products/virtual-machines/spot">
            Azure
          </a>{' '}
          list spot capacity at up to 90% off on-demand prices. For checkpointed
          Jobs, that lowers the cost of long runs. If capacity is reclaimed,
          anycloud first tries to restart the VM in place; otherwise it cleans
          up the lost VM, provisions a replacement, restores{' '}
          <code>/mnt/checkpoint</code>, and restarts the container.
        </p>
        <div className={styles.spotRecovery}>
          <PreemptionRecovery />
        </div>
        <Link className={styles.spotLink} to="/platform/jobs#spot-recovery">
          See how spot recovery works <span aria-hidden="true">→</span>
        </Link>
      </div>
    </section>
  );
}

// --- CLOSING CTA ----------------------------------------------------------
function Closing() {
  return (
    <section className={styles.closing}>
      <div className={styles.closingBg} aria-hidden="true"></div>
      <div className={styles.wrap}>
        <div className={styles.bigEmoji}>
          <img src="/img/cloud.png" alt="" width={56} height={38} />
        </div>
        <h2 className={styles.closingH2}>
          Give agents reliable primitives for working in your cloud accounts
        </h2>
        <p className={styles.closingP}>
          Your team sets the direction and limits. anycloud handles execution
          through the same CLI.
        </p>
        <div className={styles.closingCta}>
          <Link
            to="/getting-started"
            className={clsx(styles.btn, styles.btnPrimary)}
          >
            Get Started <span className={styles.arrow}>→</span>
          </Link>
          <Link
            to="/getting-started"
            className={clsx(styles.btn, styles.btnGhost)}
          >
            Read the Docs
          </Link>
        </div>
      </div>
    </section>
  );
}

// --- PAGE -----------------------------------------------------------------
export default function Home(): React.ReactElement {
  return (
    <Layout
      title="CLI for any AI workload in any cloud account"
      description="Give your team and AI agents one CLI to run jobs, Kubernetes Deployments, and VMs across the cloud accounts you connect."
    >
      <Head>
        <script type="application/ld+json">
          {JSON.stringify(STRUCTURED_DATA)}
        </script>
      </Head>
      <div className={styles.page}>
        <div className={styles.heroBg}>
          <HeroEmojis />
          <Hero />
          <Clouds />
        </div>
        <Agents />
        <Production />
        <WorkloadModes />
        <Capabilities />
        <How />
        <SpotOptimization />
        <Closing />
      </div>
    </Layout>
  );
}
