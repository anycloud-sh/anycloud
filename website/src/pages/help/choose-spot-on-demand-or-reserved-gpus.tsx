import React from 'react';
import {
  CheckList,
  DecisionFlow,
  HelpAnswer,
  HelpSection,
  PlainList,
  ShortAnswer,
  type FlowNode,
  type HelpFaq,
  type HelpRelated,
  type HelpSource,
} from '@site/src/components/HelpAnswer';

const title = 'Should I use spot, on-demand, or reserved GPUs?';
const description =
  'Use spot GPUs for resumable work, on-demand for flexible jobs without a commitment, and reserved or capacity-reserved options only when your usage or capacity needs are predictable.';
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
    label: 'AWS EC2 Reserved Instances',
    href: 'https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-reserved-instances.html',
  },
  {
    label: 'AWS EC2 Capacity Reservations',
    href: 'https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-capacity-reservations.html',
  },
  {
    label: 'AWS EC2 Capacity Blocks pricing',
    href: 'https://aws.amazon.com/ec2/capacityblocks/pricing/',
  },
  {
    label: 'AWS EC2 Capacity Blocks pricing and billing',
    href: 'https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/capacity-blocks-pricing-billing.html',
  },
  {
    label: 'Google Cloud Spot VMs',
    href: 'https://docs.cloud.google.com/compute/docs/instances/spot',
  },
  {
    label: 'Google Cloud committed use discounts',
    href: 'https://docs.cloud.google.com/compute/docs/instances/committed-use-discounts-overview',
  },
  {
    label: 'Azure Spot Virtual Machines',
    href: 'https://learn.microsoft.com/en-us/azure/virtual-machines/spot-vms',
  },
  {
    label: 'Azure Reserved VM Instances',
    href: 'https://learn.microsoft.com/en-us/azure/virtual-machines/prepay-reserved-vm-instances',
  },
  {
    label: 'Azure capacity reservations',
    href: 'https://learn.microsoft.com/en-us/azure/virtual-machines/capacity-reservation-overview',
  },
  { label: 'Lambda GPU pricing', href: 'https://lambda.ai/pricing' },
];

const related: HelpRelated[] = [
  {
    href: '/help/train-on-spot-gpus-without-losing-progress/',
    title: 'Can you train on spot GPUs without losing progress?',
  },
  {
    href: '/help/compare-gpu-prices-across-cloud-providers/',
    title: 'How do you compare GPU prices across cloud providers?',
  },
  {
    href: '/help/run-gpu-jobs-without-kubernetes/',
    title: 'How do you run GPU jobs without Kubernetes?',
  },
];

const faqs: HelpFaq[] = [
  {
    question: 'When should I use spot GPUs?',
    answer:
      'Use spot GPUs for jobs that can resume from checkpoints, tolerate variable capacity, and have no hard deadline or real-time latency requirement. Recovery after an interruption means downtime while a replacement VM starts, so latency-sensitive serving does not fit spot even with checkpointing.',
  },
  {
    question: 'When should I use on-demand GPUs?',
    answer:
      'Use on-demand GPUs when you need flexibility, do not want a long-term commitment, are still learning the workload shape, or cannot tolerate spot interruption because of deadlines or real-time latency.',
  },
  {
    question: 'Does reserved GPU capacity always guarantee availability?',
    answer:
      'No. Discount products and capacity products are different. For example, AWS Reserved Instances are billing discounts, while AWS Capacity Blocks and Capacity Reservations reserve capacity. Azure Reserved VM Instances offer prioritized capacity but do not guarantee capacity in every placement scenario.',
  },
  {
    question: 'Are reserved GPUs always cheaper?',
    answer:
      'Only when the committed usage actually happens. A discount commitment can cost more than on-demand if the team does not use enough matching GPU hours.',
  },
  {
    question: 'Is spot still cheaper after interruptions?',
    answer:
      'Yes, when the workload is checkpointed, resumable, and can tolerate slower completion. As a planning heuristic, if on-demand is 1.00x, Capacity Blocks and reservations are often about 0.35-0.75x, while Spot is often about 0.10-0.50x when capacity is healthy. In the measured workload, preemption touched 42.7% of jobs, but repeated setup was still small: about 0.74% of estimated compute cost. About 76% of preempted jobs had no measured repeated setup; among the rest, the median extra setup was 9 minutes. This excludes any extra data-transfer or egress charges from repeated download or sync work. The bigger tradeoff was recovery latency and finish-time uncertainty.',
  },
  {
    question: 'Can anycloud choose between spot and on-demand?',
    answer:
      'Yes. Set spot for interruptible runs and leave spot off for on-demand runs. Reserved or capacity-reserved usage may require pinning the credential, region, VM type, or provider setup that owns the reservation.',
  },
];

const decisionSteps: Array<{ exit: FlowNode; question: FlowNode }> = [
  {
    question: {
      title: 'Can the job resume and tolerate delayed completion?',
      detail: 'Checkpoints survive interruption, and finish time can move.',
    },
    exit: {
      condition: 'Yes',
      title: 'Spot',
      detail: 'The biggest discount. Test resume before a long run.',
    },
  },
  {
    question: {
      condition: 'No, deadline-bound, or latency-sensitive',
      title: 'Can you keep a reserved GPU window busy?',
      detail: 'Idle reserved time is still paid.',
    },
    exit: {
      condition: 'Not yet',
      title: 'On-demand',
      detail: 'Flexible and commitment-free, but still capacity-dependent.',
    },
  },
  {
    question: {
      condition: 'Yes',
      title: 'Do you need guaranteed capacity?',
      detail: 'Discounts and capacity assurance are different products.',
    },
    exit: {
      condition: 'No, discount only',
      title: 'Committed discount',
      detail:
        'Cuts the bill for matching usage; may not guarantee launch capacity.',
    },
  },
];

const decisionFinal: FlowNode = {
  condition: 'Yes',
  title: 'Capacity reservation',
  detail:
    'Holds real capacity in a specific zone and VM type, billed whether you use it or not.',
};

export default function ChooseGpuPurchaseModel(): React.ReactElement {
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
          Use spot when checkpointing makes the job resilient to interruption —
          it is the cheapest, but recovery means downtime. Use on-demand while
          usage is unpredictable or the job cannot tolerate interruption. Once
          usage is predictable, "reserved" is really two products: a committed
          discount that lowers the bill, or a capacity reservation that holds
          GPUs for you.
        </p>
      </ShortAnswer>

      <HelpSection title="A rough price map">
        <PlainList>
          <li>
            <strong>On-demand: 1.00x</strong> — flexible capacity, no
            commitment.
          </li>
          <li>
            <strong>Capacity Blocks / reservations: ~0.35-0.75x</strong> —
            predictable GPU window, paid whether the GPUs are busy or idle.
          </li>
          <li>
            <strong>Spot: ~0.10-0.50x when healthy</strong> — more resumable
            work per dollar, but interruptions can delay completion.
          </li>
        </PlainList>
        <p>
          These are planning ranges, not guarantees. Actual prices vary by
          instance type, region, date, capacity, and operating system.
        </p>
      </HelpSection>

      <HelpSection title="The decision in three questions">
        <DecisionFlow steps={decisionSteps} final={decisionFinal} />
      </HelpSection>

      <HelpSection title="What one batch workload showed">
        <p>
          In one anonymized month-long GPU batch workload, we measured{' '}
          <strong>3,771 jobs</strong>, <strong>50,707 VM attempts</strong>, and{' '}
          <strong>6,500 preempted VM attempts</strong>. Preemption touched{' '}
          <strong>42.7%</strong> of all jobs.
        </p>
        <p>There were two separate penalties:</p>
        <PlainList>
          <li>
            <strong>Extra billable setup</strong> — repeated setup after
            interruption was about <strong>0.74%</strong> of estimated compute
            cost, using recorded provider cost where available and hourly
            estimates elsewhere. About <strong>76%</strong> of preempted jobs
            had no measured repeated setup; among the rest, the median extra
            setup was <strong>9 minutes</strong>. This excludes any extra
            data-transfer or egress charges from repeated download or sync work.
          </li>
          <li>
            <strong>Job latency</strong> — wall-clock waiting for a preempted
            job to get back to <code>running</code>. Across{' '}
            <strong>537 recovery events</strong>, recovery added{' '}
            <strong>5,234.1 wall-hours</strong> of waiting: median{' '}
            <strong>37.1 minutes</strong>, average <strong>9.75 hours</strong>,
            and p95 <strong>77.71 hours</strong>. This is user-visible delay,
            not necessarily extra billed compute time, and it can overlap across
            concurrent jobs.
          </li>
        </PlainList>
        <p>
          Spot usually wins on price when jobs can absorb interruptions.
          Capacity Blocks trade lower flexibility for assured capacity in a paid
          window: they help when launch risk is more expensive than idle
          reserved time.
        </p>
      </HelpSection>

      <HelpSection title="The four options">
        <PlainList>
          <li>
            <strong>Spot</strong> — discounted capacity the provider can reclaim
            at any time. Best when checkpointing makes the workload resilient to
            losing the VM: resumable training, sweeps, batch inference,
            experiments. Not suitable for hard deadlines or real-time latency
            requirements — recovery means downtime while a replacement VM
            starts.
          </li>
          <li>
            <strong>On-demand</strong> — full-price capacity with no commitment.
            Best for first runs, jobs without checkpointing, and
            latency-sensitive work while usage is still unpredictable. It does
            not guarantee capacity: a region can still be out of the GPU you
            want.
          </li>
          <li>
            <strong>Committed discount</strong> — AWS Reserved Instances, Google
            Cloud committed use discounts, Azure Reserved VM Instances. A
            billing agreement: commit to sustained usage and matching
            consumption costs less. It holds no GPUs for you — a discounted
            launch can still fail on capacity.
          </li>
          <li>
            <strong>Capacity reservation</strong> — AWS On-Demand Capacity
            Reservations, AWS Capacity Blocks, Google Cloud reservations, Azure
            capacity reservations. An inventory hold: the provider keeps
            specific capacity (zone, VM type, or block shape) for you, billed
            whether you use it or not. It does not lower the price by itself;
            combine it with a discount for that. AWS zonal Reserved Instances
            are the exception that does both at once.
          </li>
        </PlainList>
      </HelpSection>

      <HelpSection title="A practical rollout">
        <CheckList>
          <li>
            Start with on-demand until the container, data path, and GPU fit are
            known.
          </li>
          <li>
            Move resumable jobs to spot after checkpoint and resume have been
            tested.
          </li>
          <li>
            Measure real GPU-hour usage for a few weeks before buying a
            commitment.
          </li>
          <li>
            Separate discount commitments from capacity reservations in your
            cost model.
          </li>
          <li>
            Re-check quota, live capacity, and provider terms before assuming a
            reservation applies to a new region or GPU type.
          </li>
        </CheckList>
      </HelpSection>

      <HelpSection title="Where anycloud fits">
        <p>
          anycloud can run the same submitted workload on spot or on-demand
          targets depending on the job configuration. After selecting one
          compute credential, it can choose among valid targets when region and
          VM constraints are left open.
        </p>
        <p>
          For reserved or capacity-specific setups, be more explicit. Pin the
          provider, credential, region, or VM type when the reservation only
          applies there; otherwise anycloud may pick another valid target that
          does not use the commitment.
        </p>
      </HelpSection>
    </HelpAnswer>
  );
}
