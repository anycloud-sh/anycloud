import React, { useEffect, useRef } from 'react';

import styles from './PreemptionRecovery.module.css';

// Chart geometry — copied verbatim from the source animation.
const X = (t: number) => 54 + (t / 100) * 566; // time 0–100 → px
const Y = (p: number) => 24 + (1 - p / 100) * 168; // progress 0–100% → px
const seg = (x0: number, p0: number, x1: number, p1: number) =>
  `M${X(x0)},${Y(p0)} L${X(x1)},${Y(p1)}`;

type Seg = { d: string; c: string; w: number; dash?: boolean };

// The progress line, split into colored VM runs with grey checkpoint handoffs.
const SEGS: Seg[] = [
  { d: seg(0, 0, 32, 56), c: '#22D3EE', w: 4 }, // VM 1 climbs past the 50% checkpoint
  { d: seg(32, 56, 32, 50), c: '#5E6E86', w: 4 }, // preempted — falls back to last checkpoint (50%)
  { d: seg(32, 50, 36, 50), c: '#5E6E86', w: 2.5, dash: true }, // handoff
  { d: seg(36, 50, 66, 82), c: '#A78BFA', w: 4 }, // VM 2 resumes from 50%, climbs past 75%
  { d: seg(66, 82, 66, 75), c: '#5E6E86', w: 4 }, // preempted — falls back to last checkpoint (75%)
  { d: seg(66, 75, 70, 75), c: '#5E6E86', w: 2.5, dash: true }, // handoff
  { d: seg(70, 75, 95, 100), c: '#34D399', w: 4 }, // VM 3 resumes from 75% & finishes
];

// Checkpoints sit where the climbing line crosses a gridline, so each diamond
// lands exactly on both the line and a horizontal gridline (slopes kept in
// sync with the VM runs in SEGS).
function timeAtProgress(p: number): number {
  if (p <= 56) return (p / 56) * 32; // VM 1 (0→56% over t 0→32)
  return 36 + ((p - 50) / 32) * 30; // VM 2 (50→82% over t 36→66)
}

const CHECKPOINT_LEVELS = [25, 50, 75];

const PRE: Array<[number, number]> = [
  [32, 56],
  [66, 82],
];

const GRID = [0, 25, 50, 75, 100];
const RUN = 9000; // ms sweeping the timeline
const HOLD = 1700; // ms held on the completed frame
const FADE = 450; // ms fade-out then fade-in between loops

/**
 * Animated "preemption recovery" progress chart: a job's progress climbs to
 * 100% while surviving two spot preemptions, each time resuming from the last
 * checkpoint on a fresh VM. The run fades out and replays on a loop. The SVG is
 * server-rendered in its COMPLETED state (line fully drawn to 100%, ✓ shown) so
 * the no-JS / reduced-motion fallback shows the payoff; the effect only mutates
 * animated attributes after hydration, so there is no hydration mismatch.
 */
export default function PreemptionRecovery(): React.ReactElement {
  const segRefs = useRef<Array<SVGPathElement | null>>([]);
  const dotRef = useRef<SVGCircleElement>(null);
  const haloRef = useRef<SVGCircleElement>(null);
  const preRefs = useRef<Array<SVGTextElement | null>>([]);
  const doneRef = useRef<SVGTextElement>(null);
  const contentRef = useRef<SVGGElement>(null);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    // Measure each segment so the line can be revealed progressively.
    const lens: number[] = [];
    const starts: number[] = [];
    let total = 0;
    SEGS.forEach((_, i) => {
      const L = segRefs.current[i]?.getTotalLength() ?? 0;
      starts[i] = total;
      lens[i] = L;
      total += L;
    });
    const pD = [starts[0] + lens[0], starts[3] + lens[3]];

    const col = (dist: number) => {
      for (let i = SEGS.length - 1; i >= 0; i--) {
        if (dist >= starts[i]) return SEGS[i].c;
      }
      return SEGS[0].c;
    };

    const render = (prog: number) => {
      const dist = prog * total;
      for (let i = 0; i < SEGS.length; i++) {
        const pa = segRefs.current[i];
        if (!pa) continue;
        if (SEGS[i].dash) {
          pa.style.opacity = dist > starts[i] ? '1' : '0';
          pa.setAttribute('stroke-dasharray', '2 6');
          continue;
        }
        const sh = Math.max(0, Math.min(lens[i], dist - starts[i]));
        // Hide until it starts drawing: a 0-length dash + round cap renders a
        // stray dot at the segment's start point otherwise.
        pa.style.opacity = sh <= 0.01 ? '0' : '1';
        pa.setAttribute('stroke-dasharray', `${sh} ${lens[i] - sh + 0.1}`);
      }
      let sg = 0;
      for (let j = 0; j < SEGS.length; j++) if (dist >= starts[j]) sg = j;
      const lo = Math.max(0, Math.min(lens[sg], dist - starts[sg]));
      const pt = segRefs.current[sg]?.getPointAtLength(lo);
      if (pt) {
        dotRef.current?.setAttribute('cx', String(pt.x));
        dotRef.current?.setAttribute('cy', String(pt.y));
        haloRef.current?.setAttribute('cx', String(pt.x));
        haloRef.current?.setAttribute('cy', String(pt.y));
        haloRef.current?.setAttribute('fill', col(dist));
      }
      preRefs.current.forEach((g, k) => {
        if (!g) return;
        const on = dist >= pD[k] - 1;
        g.setAttribute('opacity', on ? '1' : '0');
        g.classList.toggle(styles.blink, on);
      });
      doneRef.current?.setAttribute('opacity', prog >= 0.999 ? '1' : '0');
    };

    let raf = 0;
    let st: number | null = null;
    const fr = (ts: number) => {
      if (st === null) st = ts;
      const e = ts - st;
      let p = 1;
      let op = 1;
      if (e <= FADE) {
        p = e / RUN; // fade in while the line starts drawing
        op = e / FADE;
      } else if (e <= RUN) {
        p = e / RUN; // draw
      } else if (e <= RUN + HOLD) {
        p = 1; // hold on the completed frame
      } else if (e <= RUN + HOLD + FADE) {
        op = 1 - (e - RUN - HOLD) / FADE; // fade out
      } else {
        st = ts; // restart the loop
        p = 0;
        op = 0;
      }
      render(p);
      if (contentRef.current) contentRef.current.style.opacity = String(op);
      raf = requestAnimationFrame(fr);
    };
    raf = requestAnimationFrame(fr);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <figure className={styles.frame}>
      <span className={styles.tag}>Preemption recovery</span>
      <svg
        className={styles.svg}
        viewBox="0 0 660 208"
        role="img"
        aria-label="Job progress climbing to 100 percent while surviving two preemptions by resuming from the last checkpoint on a fresh VM."
      >
        {/* gridlines + 100% target */}
        {GRID.map((p) => (
          <line
            key={p}
            x1={54}
            y1={Y(p)}
            x2={620}
            y2={Y(p)}
            stroke="#1A2438"
            strokeWidth={1}
            aria-hidden="true"
          />
        ))}
        <line
          x1={54}
          y1={Y(100)}
          x2={620}
          y2={Y(100)}
          stroke="#34D399"
          strokeWidth={1}
          strokeDasharray="4 5"
          opacity={0.5}
          aria-hidden="true"
        />
        <text
          x={48}
          y={Y(100) + 4}
          fill="#5E6E86"
          fontSize={12}
          textAnchor="end"
          aria-hidden="true"
        >
          100%
        </text>
        <text
          x={48}
          y={Y(0) + 4}
          fill="#5E6E86"
          fontSize={12}
          textAnchor="end"
          aria-hidden="true"
        >
          0%
        </text>

        <g ref={contentRef}>
          {/* progress line — server-rendered fully drawn (completed) */}
          {SEGS.map((s, i) => (
            <path
              key={i}
              ref={(node) => {
                segRefs.current[i] = node;
              }}
              d={s.d}
              fill="none"
              stroke={s.c}
              strokeWidth={s.w}
              strokeLinecap="round"
              strokeDasharray={s.dash ? '2 6' : undefined}
              aria-hidden="true"
            />
          ))}

          {/* checkpoints — only where the line crosses a gridline */}
          {CHECKPOINT_LEVELS.map((p, i) => {
            const cx = X(timeAtProgress(p));
            const cy = Y(p);
            return (
              <rect
                key={i}
                x={cx - 5}
                y={cy - 5}
                width={10}
                height={10}
                fill="#0A0F1A"
                stroke="#7C8BA8"
                strokeWidth={1.5}
                transform={`rotate(45 ${cx} ${cy})`}
                aria-hidden="true"
              />
            );
          })}

          {/* preemption markers — server-rendered visible (completed) */}
          {PRE.map(([px, pp], k) => (
            <text
              key={k}
              ref={(node) => {
                preRefs.current[k] = node;
              }}
              x={X(px)}
              y={Y(pp) - 12}
              fill="#FBBF24"
              fontSize={22}
              textAnchor="middle"
              aria-hidden="true"
            >
              ⚡
            </text>
          ))}

          {/* tracer dot — server-rendered at the finish */}
          <circle
            ref={haloRef}
            cx={X(95)}
            cy={Y(100)}
            r={10}
            fill="#34D399"
            opacity={0.22}
            aria-hidden="true"
          />
          <circle
            ref={dotRef}
            cx={X(95)}
            cy={Y(100)}
            r={6}
            fill="#fff"
            aria-hidden="true"
          />
          <text
            ref={doneRef}
            x={X(95) - 2}
            y={Y(100) - 12}
            fill="#34D399"
            fontSize={14}
            fontWeight={700}
            textAnchor="end"
            opacity={1}
            aria-hidden="true"
          >
            ✓ 100%
          </text>
        </g>
      </svg>

      <figcaption className={styles.legend}>
        <span className={styles.item}>
          <span className={styles.sw} style={{ background: '#22D3EE' }} />
          VM 1
        </span>
        <span className={styles.item}>
          <span className={styles.sw} style={{ background: '#A78BFA' }} />
          VM 2
        </span>
        <span className={styles.item}>
          <span className={styles.sw} style={{ background: '#34D399' }} />
          VM 3
        </span>
        <span className={styles.item}>
          <span className={styles.diamond} />
          checkpoint
        </span>
        <span className={styles.item}>
          <span className={styles.bolt}>⚡</span>
          preemption
        </span>
        <span className={styles.item}>
          <span className={styles.handoff} />
          resume on a new VM
        </span>
      </figcaption>
    </figure>
  );
}
