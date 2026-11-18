import React, { useEffect, useRef, useState } from 'react';
import styles from './LaunchVideo.module.css';

// One immutable folder per cut; a new cut gets a new folder, never an overwrite.
const MEDIA = 'https://media.anycloud.sh/launch/2026-10-v2';
const SMALL_SCREEN = '(max-width: 720px)';

function autoplayAllowed(): boolean {
  const connection = (
    navigator as Navigator & { connection?: { saveData?: boolean } }
  ).connection;
  return (
    !window.matchMedia('(prefers-reduced-motion: reduce)').matches &&
    connection?.saveData !== true
  );
}

export default function LaunchVideo(): React.ReactElement {
  const videoRef = useRef<HTMLVideoElement>(null);
  // Whether the video should play while it is in view. Autoplay sets it on
  // load; the viewer's Pause and Play buttons override it.
  const wanted = useRef(false);
  const visible = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  // Set when the last <source> fails, meaning no file could load.
  const [failed, setFailed] = useState(false);

  const play = () => {
    // Rejected autoplay (for example iOS Low Power Mode) leaves the poster.
    videoRef.current?.play().catch(() => {});
  };

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    wanted.current = autoplayAllowed();
    const observer = new IntersectionObserver(
      ([entry]) => {
        visible.current = entry.isIntersecting;
        if (!entry.isIntersecting) video.pause();
        else if (wanted.current) play();
      },
      { threshold: 0.5 },
    );
    observer.observe(video);
    return () => observer.disconnect();
  }, []);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    wanted.current = video.paused;
    if (video.paused) play();
    else video.pause();
  };

  const toggleSound = () => {
    const video = videoRef.current;
    if (!video) return;
    if (!video.muted) {
      video.muted = true;
      return;
    }
    video.muted = false;
    video.currentTime = 0;
    wanted.current = true;
    play();
  };

  // Hide the panel rather than show an empty frame with dead controls.
  if (failed) return <></>;

  return (
    <figure className={styles.panel}>
      <div className={styles.frame}>
        <video
          ref={videoRef}
          className={styles.video}
          muted
          loop
          playsInline
          preload="none"
          poster={`${MEDIA}/poster.jpg`}
          width={1920}
          height={1080}
          aria-label="anycloud launch video: an agent picks a cloud account and GPU, runs a spot H100 job, and stays inside a per-session spend cap."
          aria-describedby="launch-video-transcript"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onVolumeChange={(e) => setMuted(e.currentTarget.muted)}
        >
          <source
            src={`${MEDIA}/720.av1.webm`}
            type='video/webm; codecs="av01.0.05M.08, opus"'
            media={SMALL_SCREEN}
          />
          <source
            src={`${MEDIA}/720.h264.mp4`}
            type='video/mp4; codecs="avc1.64001F, mp4a.40.2"'
            media={SMALL_SCREEN}
          />
          <source
            src={`${MEDIA}/1080.av1.webm`}
            type='video/webm; codecs="av01.0.08M.08, opus"'
          />
          <source
            src={`${MEDIA}/1080.h264.mp4`}
            type='video/mp4; codecs="avc1.640032, mp4a.40.2"'
            onError={() => setFailed(true)}
          />
        </video>
        <div className={styles.controls}>
          <button type="button" className={styles.control} onClick={togglePlay}>
            {playing ? 'Pause' : 'Play'}
          </button>
          <button
            type="button"
            className={styles.control}
            onClick={toggleSound}
          >
            {muted ? 'Play with sound' : 'Mute'}
          </button>
        </div>
      </div>
      <div id="launch-video-transcript" className={styles.srOnly}>
        <p>Your agent's next H100 run, on any of them.</p>
        <p>
          anycloud: CLI for any AI workload in any cloud account. Tell your
          coding agent <code>set up https://anycloud.sh/SKILL.md</code>.
        </p>
        <p>
          Choose the account and hardware:{' '}
          <code>anycloud job --gpu-type h100 --spot</code>. Illustrative spot
          prices: AWS $1.69/hr, Azure $2.05/hr, GCP $2.31/hr, Lambda $1.84/hr.
        </p>
        <p>
          Track and limit spend by agent session:{' '}
          <code>anycloud budget set 4000 --per day --agent-session</code>. Bars
          show spend per session, and a Slack alert in #training reads
          "anycloud: workloads waiting on spend cap".
        </p>
        <p>
          Spot saves up to 90%. A chart shows a preempted run recovering and
          reaching 100%.
        </p>
        <p>Your cloud accounts stay yours. Get Started.</p>
      </div>
      <figcaption className={styles.caption}>
        Spot prices are illustrative.{' '}
        <a href="https://aws.amazon.com/ec2/spot/">AWS</a> and{' '}
        <a href="https://azure.microsoft.com/en-us/products/virtual-machines/spot">
          Azure
        </a>{' '}
        list spot capacity at up to 90% off on-demand prices.
      </figcaption>
    </figure>
  );
}
