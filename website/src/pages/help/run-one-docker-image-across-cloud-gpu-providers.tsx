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

const title = 'Can one Docker image run across AWS, Azure, GCP, and Lambda?';
const description =
  'One Docker image can run across cloud GPU providers when it targets the right Linux architecture, avoids provider-specific assumptions, and matches the host GPU driver/runtime constraints.';
const datePublished = '2026-06-12';
const dateModified = '2026-08-18';

const sources: HelpSource[] = [
  {
    label: 'Docker multi-platform builds',
    href: 'https://docs.docker.com/build/building/multi-platform/',
  },
  {
    label: 'NVIDIA Container Toolkit install guide',
    href: 'https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html',
  },
  {
    label: 'NVIDIA CUDA compatibility',
    href: 'https://docs.nvidia.com/deploy/cuda-compatibility/index.html',
  },
  {
    label: 'anycloud Docker guide',
    href: '/platform/container-images/',
  },
  {
    label: 'anycloud Deploying Jobs',
    href: '/platform/jobs/',
  },
  {
    label: 'anycloud CLI reference',
    href: '/reference/cli-reference/',
  },
];

const related: HelpRelated[] = [
  {
    href: '/help/run-gpu-jobs-without-kubernetes/',
    title: 'How do you run GPU jobs without Kubernetes?',
  },
  {
    href: '/help/compare-gpu-prices-across-cloud-providers/',
    title: 'How do you compare GPU prices across cloud providers?',
  },
  {
    href: '/help/choose-spot-on-demand-or-reserved-gpus/',
    title: 'Should I use spot, on-demand, or reserved GPUs?',
  },
];

const faqs: HelpFaq[] = [
  {
    question: 'Can the exact same image run on every GPU cloud?',
    answer:
      'Often yes, but not automatically. The image needs the right OS and CPU architecture, compatible CUDA user-space libraries, and no assumptions about a specific cloud metadata service, filesystem path, or identity model.',
  },
  {
    question: 'Do I need a separate Dockerfile per cloud?',
    answer:
      'Usually no. Most AI batch jobs can share one Dockerfile if cloud-specific settings are passed as environment variables, mounted files, or bucket paths at runtime.',
  },
  {
    question: 'Should I build linux/amd64?',
    answer:
      'For anycloud GPU VM targets, yes. Build or publish a linux/amd64 image, especially when building from Apple Silicon, or publish a multi-platform image that includes linux/amd64.',
  },
  {
    question: 'Does the image include the GPU driver?',
    answer:
      'No. GPU containers normally include CUDA user-space libraries and application dependencies, while the host provides the NVIDIA driver and container runtime support.',
  },
  {
    question: 'Can I use a private image registry?',
    answer:
      'With anycloud, public images can come from any registry, but private image pulls are supported through GHCR authentication. Push private images to GHCR or make the image public.',
  },
];

export default function OneDockerImageAcrossClouds(): React.ReactElement {
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
          Yes, for many AI batch jobs. The honest version is that Docker gives
          you a portable package, not a guarantee that every cloud target has
          the same GPU, driver, architecture, storage, quota, or credentials.
          Build for the right platform, keep cloud-specific behavior outside the
          image, and smoke-test the image on every target class you care about.
        </p>
      </ShortAnswer>

      <HelpSection title="What must be portable">
        <CheckList>
          <li>
            The image targets the cloud VM architecture, usually{' '}
            <code>linux/amd64</code> for anycloud GPU VM targets.
          </li>
          <li>
            CUDA, PyTorch, TensorFlow, or other GPU libraries are compatible
            with the host NVIDIA driver.
          </li>
          <li>
            The startup command does not depend on a specific cloud provider's
            metadata service.
          </li>
          <li>
            Data paths are passed in at runtime, such as <code>/mnt/input</code>
            and <code>/mnt/output</code>, instead of hard-coded provider paths.
          </li>
          <li>
            Secrets and credentials come from environment variables, mounted
            files, or platform identity rather than being baked into the image.
          </li>
        </CheckList>
      </HelpSection>

      <HelpSection title="What usually breaks portability">
        <PlainList>
          <li>
            <strong>Architecture mismatch:</strong> an image built only for
            ARM64 may fail on x86 GPU VMs.
          </li>
          <li>
            <strong>Driver/runtime mismatch:</strong> a newer CUDA runtime may
            need a newer host driver than the VM image provides.
          </li>
          <li>
            <strong>Cloud-specific storage:</strong> hard-coded S3, GCS, Azure
            Blob, or local disk assumptions can make the same image behave
            differently.
          </li>
          <li>
            <strong>Private registry auth:</strong> the image may be portable,
            but the VM still needs permission to pull it.
          </li>
        </PlainList>
      </HelpSection>

      <HelpSection title="A practical smoke test">
        <CheckList>
          <li>Build and push the image by digest, not only by a moving tag.</li>
          <li>
            Run <code>nvidia-smi</code> or a tiny CUDA/PyTorch check at startup.
          </li>
          <li>
            Read a small file from input storage and write a small output file.
          </li>
          <li>
            Run the same command on the GPU families and providers you plan to
            use before launching a long job.
          </li>
          <li>
            Keep provider-specific tuning in configuration, not in separate
            image builds, unless the dependency really differs by provider.
          </li>
        </CheckList>
      </HelpSection>

      <HelpSection title="Where anycloud fits">
        <p>
          anycloud is designed around this model: submit a Docker image, GPU
          target, command, and optional buckets, then let anycloud provision a
          VM, pull the image, mount configured folders, run the container, and
          clean up.
        </p>
        <p>
          The image still has to be a good Linux GPU image. anycloud can move
          the job across clouds, but it cannot make an ARM-only image run on an
          x86 target, fix a CUDA/driver mismatch inside the container, or infer
          provider-specific credentials that were baked into the app.
        </p>
      </HelpSection>
    </HelpAnswer>
  );
}
