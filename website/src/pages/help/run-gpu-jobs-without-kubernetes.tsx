import React from 'react';
import {
  CheckList,
  HelpAnswer,
  HelpSection,
  PlainList,
  type HelpFaq,
  type HelpRelated,
  type HelpSource,
  ShortAnswer,
} from '@site/src/components/HelpAnswer';

const title = 'How do you run GPU jobs without Kubernetes?';
const description =
  "Most batch GPU jobs don't need a cluster. Run Dockerized training and batch workloads on a GPU VM, through a managed batch service, or with a job runner — without operating a cluster.";
const datePublished = '2026-06-12';
const dateModified = '2026-08-18';

const sources: HelpSource[] = [
  {
    label: 'Kubernetes Jobs',
    href: 'https://kubernetes.io/docs/concepts/workloads/controllers/job/',
  },
  {
    label: 'Kubernetes GPU scheduling',
    href: 'https://kubernetes.io/docs/tasks/manage-gpus/scheduling-gpus/',
  },
  {
    label: 'AWS Batch GPU jobs',
    href: 'https://docs.aws.amazon.com/batch/latest/userguide/gpu-jobs.html',
  },
  {
    label: 'Google Cloud Batch GPU jobs',
    href: 'https://docs.cloud.google.com/batch/docs/create-run-job-gpus',
  },
  {
    label: 'Azure Batch GPU and RDMA pools',
    href: 'https://learn.microsoft.com/en-us/azure/batch/batch-pool-compute-intensive-sizes',
  },
  {
    label: 'Amazon ECS GPU workloads',
    href: 'https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs-gpu.html',
  },
];

const related: HelpRelated[] = [
  {
    href: '/help/compare-gpu-prices-across-cloud-providers/',
    title: 'How do you compare GPU prices across cloud providers?',
  },
  {
    href: '/help/train-on-spot-gpus-without-losing-progress/',
    title: 'Can you train on spot GPUs without losing progress?',
  },
  {
    href: '/help/run-one-docker-image-across-cloud-gpu-providers/',
    title: 'Can one Docker image run across AWS, Azure, GCP, and Lambda?',
  },
];

const faqs: HelpFaq[] = [
  {
    question: 'Do you need Kubernetes to run GPU training jobs?',
    answer:
      'No. If the workload is a batch job that can run in a Docker container, you can run it on a GPU VM, through a managed batch service, or with a job runner without operating a Kubernetes cluster.',
  },
  {
    question: 'When is Kubernetes worth it for GPUs?',
    answer:
      'Kubernetes is worth considering when a team already runs a platform and needs shared scheduling, long-running services, multi-tenant policy, custom controllers, or consistent operations across many workloads.',
  },
  {
    question: 'How do you get data in and out without a cluster?',
    answer:
      'Use object storage, mounted disks, or job-runner file sync. For batch training, the common pattern is to download input data before the run and upload outputs and checkpoints afterward or during the run.',
  },
  {
    question: 'Can managed batch services run GPU jobs?',
    answer:
      'Yes. AWS Batch and Google Cloud Batch both document GPU job support, and Azure Batch supports GPU VM sizes in batch pools. The tradeoff is that each provider has its own setup and job definition model.',
  },
  {
    question: 'How does anycloud run GPU jobs without Kubernetes?',
    answer:
      'anycloud launches cloud GPU VMs in connected accounts, runs your Docker container, syncs configured folders, reports status, and tears down compute after the job.',
  },
];

export default function RunGpuJobsWithoutKubernetes(): React.ReactElement {
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
          Use a Docker image and run it on a GPU VM, through a managed batch
          service, or with a job runner. Kubernetes is useful for shared
          platforms and long-running services, but most batch GPU jobs just need
          to start a GPU, run a container, save outputs, and shut down.
        </p>
      </ShortAnswer>

      <HelpSection title="The job-runner model">
        <p>
          Many GPU workloads are batch jobs. They do not need service discovery,
          ingress, rolling deploys, or always-on nodes. They need:
        </p>
        <CheckList>
          <li>
            A container image with a compatible CUDA runtime and the required
            dependencies
          </li>
          <li>A machine shape with the right GPU and memory</li>
          <li>A command to run</li>
          <li>A way to get input data in</li>
          <li>A way to persist outputs and checkpoints</li>
          <li>Logging, status reporting, retries, and cleanup</li>
        </CheckList>
        <p>
          You can build that with a small script around cloud VMs, a managed
          service such as AWS Batch, Google Cloud Batch, or Azure Batch, or a
          higher-level GPU job runner.
        </p>
      </HelpSection>

      <HelpSection title="What Kubernetes adds">
        <p>
          Kubernetes can run GPU workloads. Official Kubernetes docs describe
          GPU scheduling through device plugins, and Kubernetes Jobs are the
          native API for one-off tasks that run to completion.
        </p>
        <p>
          The cluster also adds operational surface area: node pools,
          autoscaling, device plugin installation, driver compatibility, quotas,
          storage classes, image pulls, observability, cost controls, access
          policy, upgrades, and failure debugging. That work may be worth it for
          a platform team. It may be overhead for a small team trying to run
          portable GPU jobs.
        </p>
      </HelpSection>

      <HelpSection title="Alternatives to Kubernetes">
        <PlainList>
          <li>
            <strong>Direct VM:</strong> launch a GPU VM, SSH in or use
            cloud-init, run Docker, upload results, and shut the VM down.
          </li>
          <li>
            <strong>Managed batch:</strong> use AWS Batch, Google Cloud Batch,
            or Azure Batch. These handle queues and compute pools, but each
            cloud has its own configuration model.
          </li>
          <li>
            <strong>Container services:</strong> ECS and similar systems can run
            GPU containers without Kubernetes, though they still require
            provider-specific setup.
          </li>
          <li>
            <strong>Portable job runner:</strong> submit one Docker image and
            let a tool handle VM provisioning, file movement, status, and
            shutdown.
          </li>
        </PlainList>
      </HelpSection>

      <HelpSection title="Where anycloud fits">
        <p>
          anycloud is a portable job runner. You submit a Docker image, GPU
          target, command, and optional buckets. anycloud provisions compute in
          your connected cloud account, runs the container, exposes
          bucket-backed folders such as <code>/mnt/input</code> and{' '}
          <code>/mnt/output</code>, reports job status, and shuts down compute
          when the job finishes.
        </p>
      </HelpSection>
    </HelpAnswer>
  );
}
