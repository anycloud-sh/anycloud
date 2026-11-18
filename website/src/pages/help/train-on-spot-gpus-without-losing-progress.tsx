import React from 'react';
import Link from '@docusaurus/Link';
import {
  CheckList,
  HelpAnswer,
  HelpSection,
  type HelpFaq,
  type HelpRelated,
  type HelpSource,
  ShortAnswer,
} from '@site/src/components/HelpAnswer';
import PreemptionRecovery from '@site/src/components/PreemptionRecovery';

const title = 'Can you train on spot GPUs without losing progress?';
const description =
  'Yes — if the job checkpoints to durable storage and restarts cleanly. Learn what to save, how often to save it, and how to test recovery before a long run.';
const datePublished = '2026-06-12';
const dateModified = '2026-08-18';

const sources: HelpSource[] = [
  {
    label: 'AWS EC2 Spot Instance interruptions',
    href: 'https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/spot-interruptions.html',
  },
  {
    label: 'AWS Spot interruption notices',
    href: 'https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/spot-instance-termination-notices.html',
  },
  {
    label: 'Google Cloud Spot VMs',
    href: 'https://docs.cloud.google.com/compute/docs/instances/spot',
  },
  {
    label: 'Azure Spot Virtual Machines',
    href: 'https://learn.microsoft.com/en-us/azure/virtual-machines/spot-vms',
  },
  {
    label: 'PyTorch checkpoint docs',
    href: 'https://docs.pytorch.org/tutorials/beginner/saving_loading_models.html',
  },
  {
    label: 'TensorFlow checkpoint docs',
    href: 'https://www.tensorflow.org/guide/checkpoint',
  },
];

const related: HelpRelated[] = [
  {
    href: '/help/compare-gpu-prices-across-cloud-providers/',
    title: 'How do you compare GPU prices across cloud providers?',
  },
  {
    href: '/help/run-gpu-jobs-without-kubernetes/',
    title: 'How do you run GPU jobs without Kubernetes?',
  },
  {
    href: '/help/choose-spot-on-demand-or-reserved-gpus/',
    title: 'Should I use spot, on-demand, or reserved GPUs?',
  },
];

const faqs: HelpFaq[] = [
  {
    question: 'Do spot GPUs keep running until my job finishes?',
    answer:
      'No. Spot and preemptible VMs can be reclaimed. Treat them as temporary compute and design the training job to resume from checkpoint files.',
  },
  {
    question: 'Can a checkpoint resume optimizer state?',
    answer:
      'Yes, if you save it. Frameworks such as PyTorch and TensorFlow can save more than model weights, including optimizer state and training step metadata.',
  },
  {
    question: 'How much progress can be lost after interruption?',
    answer:
      'You can lose work since the last durable checkpoint. If checkpoints are uploaded or written every few minutes, the rerun window is usually a few minutes rather than the whole job.',
  },
  {
    question: 'Are spot GPUs safe for production training?',
    answer:
      'They can be, if the job is checkpointed, resumable, and the business can tolerate delayed completion. For non-resumable jobs or fixed deadlines, on-demand or reserved capacity may be safer.',
  },
  {
    question: 'Does anycloud automatically checkpoint my model?',
    answer:
      'No. anycloud syncs and restores checkpoint files, but your code or ML framework still needs to write those files.',
  },
];

export default function TrainOnSpotGpus(): React.ReactElement {
  return (
    <HelpAnswer
      title={title}
      description={description}
      datePublished={datePublished}
      dateModified={dateModified}
      faqs={faqs}
      sources={sources}
      related={related}
    >
      <ShortAnswer>
        <p>
          Yes, if the training job can resume from durable checkpoints. Spot and
          preemptible GPUs can be reclaimed by the cloud provider, so the
          process in memory can disappear. The safe pattern is to write enough
          state that losing the VM does not mean losing the run.
        </p>
      </ShortAnswer>

      <HelpSection title="What spot interruption really means">
        <p>
          Spot capacity is discounted because the provider can reclaim it. AWS
          Spot Instances can be stopped, hibernated, or terminated, and AWS
          provides advance notice before many interruptions. Google Cloud Spot
          VMs can be preempted when capacity is needed. Azure Spot VMs can be
          evicted when Azure needs capacity or when the current price exceeds a
          configured max price.
        </p>
        <p>
          The important part: the cloud does not preserve your Python process. A
          training run resumes only if your code or framework writes resumable
          state and reads it on startup.
        </p>
      </HelpSection>

      <HelpSection title="What to save">
        <p>
          For a serious training job, save more than model weights. A useful
          checkpoint usually includes:
        </p>
        <CheckList>
          <li>Model weights</li>
          <li>Optimizer state</li>
          <li>Learning-rate scheduler state</li>
          <li>Global step or epoch</li>
          <li>Random seeds or sampler state when reproducibility matters</li>
          <li>Mixed-precision scaler state</li>
          <li>
            Configuration needed to validate the checkpoint against the run
          </li>
        </CheckList>
        <p>
          PyTorch, TensorFlow, Lightning, and Hugging Face Trainer all support
          checkpoint-based resume patterns. The exact API differs, but the
          infrastructure rule is the same: write checkpoint files somewhere that
          survives VM loss.
        </p>
      </HelpSection>

      <HelpSection title="How often to checkpoint">
        <p>
          Checkpoint frequency is a cost tradeoff. Frequent checkpoints reduce
          lost work but add I/O and storage overhead. Large checkpoints can also
          take long enough to write that they interfere with training.
        </p>
        <p>
          For spot training, aim to lose minutes, not hours. Write atomically
          when possible: save to a temporary path, flush the file, then rename
          it into place so a restart does not read a half-written checkpoint.
        </p>
      </HelpSection>

      <HelpSection title="A resume checklist">
        <CheckList>
          <li>The container can start from scratch with the same command.</li>
          <li>
            Startup code checks for an existing checkpoint before training
            begins.
          </li>
          <li>
            Checkpoints are written to durable storage, not only the VM boot
            disk.
          </li>
          <li>
            Outputs are separated from checkpoints so partial artifacts do not
            look final.
          </li>
          <li>
            Provider-specific interruption hooks, shutdown scripts, or scheduled
            events save a final checkpoint when advance notice is available.
          </li>
          <li>
            You have tested resume by killing a small job and restarting it.
          </li>
        </CheckList>
      </HelpSection>

      <HelpSection title="Where anycloud fits">
        <p>
          anycloud's spot recovery path gives jobs a checkpoint folder at{' '}
          <code>/mnt/checkpoint</code>. Your training code writes checkpoint
          files there; anycloud uploads checkpoint changes and restores them
          before restarting the container after preemption.
        </p>
        <p>
          anycloud moves files and restarts the job. It does not invent
          framework checkpoints for you.
        </p>
        <PreemptionRecovery />
        <p>
          For the buying decision, see{' '}
          <Link to="/help/choose-spot-on-demand-or-reserved-gpus/">
            when spot, on-demand, or reserved GPUs make sense
          </Link>
          .
        </p>
      </HelpSection>
    </HelpAnswer>
  );
}
