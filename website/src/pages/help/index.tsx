import React from 'react';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';

import styles from './help.module.css';

const ANSWERS = [
  {
    href: '/help/anycloud-vs-skypilot/',
    title: 'Anycloud vs SkyPilot for spot GPU training',
    description:
      'Compare container-based spot training, checkpoint recovery, and workflow requirements before choosing Anycloud or SkyPilot.',
  },
  {
    href: '/help/anycloud-vs-azure-container-apps/',
    title: 'Anycloud vs Azure Container Apps for HTTP services',
    description:
      'Choose between an Anycloud Service on selected compute and Azure Container Apps with managed ingress, revisions, and autoscaling.',
  },
  {
    href: '/help/anycloud-vs-devpod/',
    title: 'Anycloud vs DevPod for persistent development VMs',
    description:
      'Compare a published development container on an Anycloud VM with DevPod workspaces defined through devcontainer.json.',
  },

  {
    href: '/help/compare-gpu-prices-across-cloud-providers/',
    title: 'How do you compare GPU prices across cloud providers?',
    description:
      'Compare GPU jobs by completed-run cost, not only hourly price. Region, quota, capacity, spot risk, storage, and startup time all change the real number.',
  },
  {
    href: '/help/train-on-spot-gpus-without-losing-progress/',
    title: 'Can you train on spot GPUs without losing progress?',
    description:
      'Spot GPUs can work for training if the job writes durable checkpoints and can restart cleanly after the VM is reclaimed.',
  },
  {
    href: '/help/run-gpu-jobs-without-kubernetes/',
    title: 'How do you run GPU jobs without Kubernetes?',
    description:
      'For many batch workloads, running a Docker image on a GPU VM or using a managed batch service or job runner is simpler than operating a GPU cluster.',
  },
  {
    href: '/help/choose-spot-on-demand-or-reserved-gpus/',
    title: 'Should I use spot, on-demand, or reserved GPUs?',
    description:
      'Use spot for resumable work, on-demand while usage is uncertain, and Capacity Blocks when a predictable paid GPU window matters.',
  },
  {
    href: '/help/run-one-docker-image-across-cloud-gpu-providers/',
    title: 'Can one Docker image run across AWS, Azure, GCP, and Lambda?',
    description:
      'One image can work across GPU clouds when it targets linux/amd64, keeps cloud-specific settings out of the image, and matches driver/runtime constraints.',
  },
  {
    href: '/help/custom-docker-image-for-gpu-training/',
    title: 'Do you need a custom Docker image for GPU training?',
    description:
      'Often no — public PyTorch and CUDA images cover most training jobs. Build your own only when dependencies are not available off the shelf.',
  },
];

export default function HelpHub(): React.ReactElement {
  const { siteConfig } = useDocusaurusContext();
  const slackInviteUrl = siteConfig.customFields?.slackInviteUrl;

  return (
    <Layout
      title="Cloud workload answers"
      description="Answers about cloud Jobs, HTTP Services, development VMs, and choosing tools for container workloads."
    >
      <main className={styles.page}>
        <section className={styles.hero}>
          <div className={styles.wrap}>
            <h1 className={styles.title}>Cloud workload answers</h1>
            <p className={styles.lede}>
              Direct answers about cloud containers — choosing tools, running
              GPU Jobs, hosting HTTP Services, and keeping development
              workspaces available.
            </p>
          </div>
        </section>

        <section className={styles.answers} aria-label="Help answers">
          <div className={`${styles.wrap} ${styles.answerGrid}`}>
            {ANSWERS.map((answer) => (
              <article key={answer.href} className={styles.card}>
                <h2>
                  <Link to={answer.href} className={styles.cardLink}>
                    {answer.title}
                  </Link>
                </h2>
                <p>{answer.description}</p>
              </article>
            ))}
          </div>
        </section>

        <section className={styles.cta}>
          <div className={styles.wrap}>
            <h2>Have a question that isn't here?</h2>
            {typeof slackInviteUrl === 'string' && (
              <a className={styles.ctaLink} href={slackInviteUrl}>
                Ask in the community Slack
              </a>
            )}
          </div>
        </section>
      </main>
    </Layout>
  );
}
