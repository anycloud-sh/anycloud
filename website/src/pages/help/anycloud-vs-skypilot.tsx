import React from 'react';
import {
  HelpAnswer,
  HelpSection,
  ShortAnswer,
} from '@site/src/components/HelpAnswer';

export default function Comparison(): React.ReactElement {
  return (
    <HelpAnswer
      title="Anycloud vs SkyPilot for spot GPU training"
      description="Compare container-based spot training, checkpoint recovery, and workflow requirements before choosing Anycloud or SkyPilot."
      datePublished="2026-10-08"
      dateModified="2026-10-08"
      sources={[
        {
          label: 'SkyPilot managed jobs',
          href: 'https://docs.skypilot.ai/en/latest/examples/managed-jobs.html',
        },
        { label: 'Anycloud workload documentation', href: '/platform/jobs' },
      ]}
      faqs={[
        {
          question: 'Does either tool make training automatically resumable?',
          answer:
            'No. Recovery needs application code that periodically saves checkpoints to persistent storage and loads them on restart.',
        },
      ]}
    >
      <ShortAnswer>
        <p>
          Choose Anycloud when your training code is already in a published
          container and you want a Job command with bucket sync, logs, and cost
          tracking. Choose SkyPilot when its YAML tasks, managed pipelines, or
          multi-node workflows fit your training setup. Both require application
          checkpoints to recover useful progress.
        </p>
      </ShortAnswer>
      <HelpSection title="Compare the training workflow">
        <p>
          SkyPilot managed jobs provision resources, recover from preemptions
          and other failures, and clean up when finished. Its documented
          workflow uses YAML tasks and supports managed pipelines and multi-node
          Jobs.
        </p>
        <p>
          Anycloud Jobs run published containers with a command, hardware
          target, and optional buckets. A VM-host Job creates one host; use it
          when the training process fits on that machine.
        </p>
        <p>
          Compare the number of GPUs per host, cloud quota, checkpoint storage,
          and startup time. Neither tool makes training resumable unless the
          application saves and reloads its state.
        </p>
      </HelpSection>
      <HelpSection title="Run the published training image with Anycloud">
        <p>
          Assuming the CLI and a named cloud credential are configured, choose
          one credential and an available H100 target. Replace the placeholders
          before running:
        </p>
        <pre>
          <code>{String.raw`anycloud job ghcr.io/example/training:latest \
  --credentials <aws-or-gcp-credential> \
  --gpu-type h100 --gpus all --spot \
  --output-bucket <unique-results-bucket> \
  -- python train.py
anycloud logs <job-id> --follow
anycloud cost <job-id>`}</code>
        </pre>
        <p>
          <code>--gpus all</code> uses every GPU on the selected host, which may
          be more than one. The training code must write checkpoints to{' '}
          <code>/mnt/checkpoint</code> and load them on restart. Sync runs about
          every 60 seconds, so the latest unsynced work can be lost. An
          automatically created checkpoint bucket is removed when the Job
          finishes; use a pre-existing checkpoint bucket to retain checkpoints
          between Jobs.
        </p>
        <p>
          A named compute credential selects one cloud identity. Compare AWS and
          GCP availability and prices before selecting it; repeating{' '}
          <code>--credentials</code> is rejected.
        </p>
      </HelpSection>
    </HelpAnswer>
  );
}
