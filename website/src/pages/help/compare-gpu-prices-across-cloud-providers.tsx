import React from 'react';
import {
  CheckList,
  HelpAnswer,
  HelpSection,
  PlainList,
  ShortAnswer,
  type HelpFaq,
  type HelpRelated,
  type HelpSource,
} from '@site/src/components/HelpAnswer';

const title = 'How do you compare GPU prices across cloud providers?';
const description =
  'Compare cloud GPUs on cost per completed job, not hourly list price. GPU class, region, quota, capacity, spot risk, and data transfer all change the real number.';
const datePublished = '2026-06-12';
const dateModified = '2026-08-18';

const sources: HelpSource[] = [
  {
    label: 'AWS EC2 On-Demand pricing',
    href: 'https://aws.amazon.com/ec2/pricing/on-demand/',
  },
  {
    label: 'AWS EC2 Spot pricing',
    href: 'https://aws.amazon.com/ec2/spot/pricing/',
  },
  {
    label: 'Google Cloud Compute Engine pricing',
    href: 'https://cloud.google.com/products/compute/pricing',
  },
  {
    label: 'Google Cloud accelerator pricing',
    href: 'https://cloud.google.com/products/compute/pricing/accelerator-optimized',
  },
  {
    label: 'Azure Spot Virtual Machines',
    href: 'https://azure.microsoft.com/en-us/products/virtual-machines/spot',
  },
  {
    label: 'Azure Linux Virtual Machines pricing',
    href: 'https://azure.microsoft.com/en-us/pricing/details/virtual-machines/linux/',
  },
  { label: 'Lambda GPU pricing', href: 'https://lambda.ai/pricing' },
];

const related: HelpRelated[] = [
  {
    href: '/help/train-on-spot-gpus-without-losing-progress/',
    title: 'Can you train on spot GPUs without losing progress?',
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
    question: 'What is the cheapest cloud GPU?',
    answer:
      'There is no single cheapest GPU. The answer changes by GPU model, region, provider, purchase model, quota, capacity, and whether your job can tolerate interruption. Compare current prices for the exact workload shape.',
  },
  {
    question: 'Why do cloud GPU prices vary by region?',
    answer:
      'GPU supply, demand, power, data center inventory, and spot market conditions vary by region. A GPU can be cheaper in one region and unavailable in another, even inside the same cloud.',
  },
  {
    question: 'Should I compare per GPU-hour or per job?',
    answer:
      'Use GPU-hour price for quick screening, but use completed-job cost for real decisions. Completed-job cost captures startup time, retries, transfer, and interruption risk.',
  },
  {
    question: 'Is spot always the cheapest option?',
    answer:
      'Spot is often cheaper, but it is not always the best value. Long jobs without checkpoints can lose work after interruption, and some production workloads need guaranteed capacity more than a lower hourly price.',
  },
  {
    question: 'Why can a cheap GPU fail to launch?',
    answer:
      'Public pricing does not guarantee account quota or live capacity. Your account may need a quota increase, or the region may not have the requested GPU capacity when the job starts.',
  },
];

export default function CompareGpuPrices(): React.ReactElement {
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
          Compare the cost of a completed job, not just the posted hourly rate.
          Start with the exact GPU class you need, then check region, purchase
          model, quota, capacity, storage, network transfer, and interruption
          risk.
        </p>
      </ShortAnswer>

      <HelpSection title="Start with a comparable unit">
        <p>
          Cloud GPU SKUs are not interchangeable just because they use the same
          NVIDIA marketing name. Compare the same practical shape:
        </p>
        <CheckList>
          <li>GPU model and memory, such as H100 80 GB vs H100 NVL</li>
          <li>GPU count per VM</li>
          <li>CPU, RAM, local SSD, and network bandwidth</li>
          <li>Interconnect requirements for multi-node training</li>
          <li>Region and zone</li>
          <li>
            On-demand, spot, reserved, committed, or capacity-reserved price
          </li>
          <li>Operating system, driver, and container image requirements</li>
        </CheckList>
        <p>
          AWS, Google Cloud, Azure, and specialist GPU clouds publish pricing in
          different formats. Decide what counts as an acceptable target before
          comparing any prices.
        </p>
      </HelpSection>

      <HelpSection title="Why list price is not enough">
        <p>
          The useful number is usually dollars per successful run. Hourly price
          is only one input.
        </p>
        <p>
          Quota can block a launch even when the public price looks good.
          Regional capacity can make a GPU unavailable at the moment you need
          it. Spot instances can lower compute cost but increase restart risk.
          Storage and egress can matter when training data or model artifacts
          are large. Startup time matters when jobs are short or repeated many
          times.
        </p>
        <PlainList>
          <li>
            <strong>GPU-hour price:</strong> useful for budgeting and coarse
            provider comparison.
          </li>
          <li>
            <strong>Completed-job price:</strong> better for real decisions
            because it includes retries, failed launches, storage transfer, and
            idle setup time.
          </li>
        </PlainList>
      </HelpSection>

      <HelpSection title="A practical comparison workflow">
        <CheckList>
          <li>
            Choose acceptable GPU classes, not one provider SKU. For example,
            decide whether an H100, H200, B200, A100, L40S, or A10G can run the
            workload.
          </li>
          <li>
            List allowed regions. Remove regions that violate latency, data
            residency, or team access requirements.
          </li>
          <li>
            Pull current on-demand and spot prices from each provider's public
            pricing page or pricing API.
          </li>
          <li>Check quota and launch permissions in each account.</li>
          <li>
            Run a small Docker-based smoke test on every candidate target.
          </li>
          <li>
            Track finished-job cost over time. Use the winner for similar jobs,
            but re-check prices and capacity before large runs.
          </li>
        </CheckList>
      </HelpSection>

      <HelpSection title="Where anycloud fits">
        <p>
          anycloud is useful when you already have multiple cloud accounts or
          credit pools and want one way to submit jobs. Instead of hard-coding
          one provider and region, you submit a Docker image or Python job with
          one selected cloud account. Within that account, anycloud can choose a
          valid target and region from the constraints you provide.
        </p>
        <p>
          That does not replace the fundamentals above: you still need usable
          credentials, quota, data placement, and a workload that can run
          portably. It does reduce the manual work of comparing targets and
          rerunning the same job flow across clouds.
        </p>
      </HelpSection>
    </HelpAnswer>
  );
}
