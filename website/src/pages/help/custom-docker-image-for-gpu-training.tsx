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

const title = 'Do you need a custom Docker image for GPU training?';
const description =
  'Often no — public PyTorch and CUDA images cover most GPU training jobs. Build a custom image only when your dependencies are not available off the shelf.';
const datePublished = '2026-06-12';
const dateModified = '2026-06-12';

const sources: HelpSource[] = [
  {
    label: 'Docker getting started',
    href: 'https://docs.docker.com/get-started/',
  },
  {
    label: 'Dockerfile reference',
    href: 'https://docs.docker.com/reference/dockerfile/',
  },
  {
    label: 'Docker multi-platform builds',
    href: 'https://docs.docker.com/build/building/multi-platform/',
  },
  {
    label: 'PyTorch Docker images',
    href: 'https://hub.docker.com/r/pytorch/pytorch',
  },
  {
    label: 'NVIDIA CUDA images',
    href: 'https://hub.docker.com/r/nvidia/cuda',
  },
  {
    label: 'anycloud Docker guide',
    href: '/platform/container-images/',
  },
  {
    label: 'anycloud Deploying Jobs',
    href: '/platform/jobs/',
  },
];

const related: HelpRelated[] = [
  {
    href: '/help/run-one-docker-image-across-cloud-gpu-providers/',
    title: 'Can one Docker image run across AWS, Azure, GCP, and Lambda?',
  },
  {
    href: '/help/run-gpu-jobs-without-kubernetes/',
    title: 'How do you run GPU jobs without Kubernetes?',
  },
  {
    href: '/help/train-on-spot-gpus-without-losing-progress/',
    title: 'Can you train on spot GPUs without losing progress?',
  },
];

const faqs: HelpFaq[] = [
  {
    question: 'Can I train with a stock PyTorch image?',
    answer:
      'Yes. Public images such as pytorch/pytorch with CUDA tags include the framework and the GPU runtime libraries. Pass your training command and bring the code at run time.',
  },
  {
    question: 'How does my code get into the container without a custom image?',
    answer:
      'Clone it from git when the container starts, install it as a package, or read it from storage mounted into the container. The image only needs the tools those steps use, such as git.',
  },
  {
    question: 'Why does an image built on a Mac fail on a cloud GPU VM?',
    answer:
      'Apple Silicon builds default to arm64, while cloud GPU VMs run linux/amd64. The pull can succeed and the container still fail to start. Build with docker buildx --platform linux/amd64.',
  },
  {
    question: 'When is a custom Dockerfile worth it?',
    answer:
      'When the job needs system packages, compiled CUDA extensions, or pinned dependencies that no public image provides. Build it in CI so every image is tied to the commit that built it.',
  },
  {
    question: 'Does anycloud build my Docker image?',
    answer:
      'No. anycloud pulls a prebuilt image and runs it. Build and push the image first; public images work from any registry, and private images are supported through GHCR.',
  },
];

export default function CustomDockerImageForGpuTraining(): React.ReactElement {
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
          Often no. If a public image such as <code>pytorch/pytorch</code> or{' '}
          <code>nvidia/cuda</code> already has the runtime your job needs, run
          it directly and bring your code at run time. Build and push a custom
          image only when the job needs dependencies no off-the-shelf image
          provides.
        </p>
      </ShortAnswer>

      <HelpSection title="What the image is actually for">
        <p>
          A training image has one job: provide the runtime. That means the
          operating system, the CUDA user-space libraries, and the ML framework
          — not necessarily your code. Your code can arrive separately when the
          container starts:
        </p>
        <CheckList>
          <li>Baked into the image with a Dockerfile COPY step</li>
          <li>Cloned from git when the container starts</li>
          <li>Installed as a package at startup</li>
          <li>Read from storage mounted into the container</li>
        </CheckList>
        <p>
          Separating the runtime from the code is what makes stock images
          viable: the image changes only when dependencies change, not on every
          commit.
        </p>
      </HelpSection>

      <HelpSection title="When a public image is enough">
        <p>
          Most training and fine-tuning jobs import a framework, read data, and
          write checkpoints. A stock framework image already covers that, and
          skipping the build means no build-push loop on every change, no
          registry credentials to manage, and faster iteration. A public image
          is enough when:
        </p>
        <CheckList>
          <li>
            Your dependencies import cleanly inside a stock framework image
          </li>
          <li>The job is a script or module the image can run as a command</li>
          <li>The code is reachable at run time, from git or from storage</li>
          <li>You need no system packages beyond what the image ships</li>
        </CheckList>
      </HelpSection>

      <HelpSection title="When to build your own">
        <PlainList>
          <li>
            <strong>System dependencies:</strong> the job needs OS packages,
            custom drivers for data loading, or tools no public image ships.
          </li>
          <li>
            <strong>Compiled extensions:</strong> CUDA extensions or native code
            that must be compiled into the environment ahead of time.
          </li>
          <li>
            <strong>Strict reproducibility:</strong> every dependency pinned and
            frozen, so the same image re-runs identically months later.
          </li>
          <li>
            <strong>No network at startup:</strong> the container cannot fetch
            code or packages at run time, so everything must be baked in.
          </li>
        </PlainList>
        <p>
          If you do build, build for the platform the GPU VM runs:{' '}
          <code>linux/amd64</code>. On Apple Silicon use{' '}
          <code>docker buildx --platform linux/amd64</code>, since a plain build
          publishes an arm64 image that pulls successfully but cannot start on
          an x86 VM. Start from a CUDA or framework base image, and prefer
          building in CI so each image is tied to the commit that built it.
        </p>
      </HelpSection>

      <HelpSection title="Where anycloud fits">
        <p>
          anycloud runs any pullable image on a cloud GPU VM — public images
          from any registry, private images through GHCR. It does not build
          images: build and push first, then submit the image reference with a
          command.
        </p>
        <p>
          Application code and dependencies belong in the published image. Tag
          images with the source commit and arrange Dockerfile layers so code
          changes reuse cached dependency installation.
        </p>
      </HelpSection>
    </HelpAnswer>
  );
}
