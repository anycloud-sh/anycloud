import React from 'react';
import {
  HelpAnswer,
  HelpSection,
  ShortAnswer,
} from '@site/src/components/HelpAnswer';

export default function Comparison(): React.ReactElement {
  return (
    <HelpAnswer
      title="Anycloud vs DevPod for persistent development VMs"
      description="Compare a published development container on an Anycloud VM with DevPod workspaces defined through devcontainer.json."
      datePublished="2026-10-08"
      dateModified="2026-10-08"
      sources={[
        {
          label: 'DevPod workspace creation and persistence',
          href: 'https://devpod.sh/docs/developing-in-workspaces/create-a-workspace',
        },
        { label: 'Anycloud workload documentation', href: '/platform/vms' },
      ]}
      faqs={[
        {
          question: 'Does the Anycloud workspace survive terminating the VM?',
          answer:
            'No. /workspace survives container recreation and host reboot during the VM lifetime, but termination destroys its host disk.',
        },
      ]}
    >
      <ShortAnswer>
        <p>
          Choose DevPod when you want a devcontainer.json workflow,
          repository-based workspaces, and IDE integration. Choose an Anycloud
          VM when you already have a compatible published development image and
          want explicit VM sizing plus container and host SSH access.
        </p>
      </ShortAnswer>
      <HelpSection title="Compare workspace setup">
        <p>
          DevPod creates workspaces from a repository, local path, or Docker
          image. It uses <code>devcontainer.json</code> and can open the
          workspace in an IDE. When recreating a container, its project
          directory and mounted volumes are preserved; other container changes
          are lost.
        </p>
        <p>
          Anycloud VMs use a supplied image on one on-demand cloud host.
          Anycloud does not install development tools into that image. Include
          the tools you need, along with <code>/bin/sh</code> and POSIX{' '}
          <code>sleep</code>, and allow the entrypoint, command, and working
          directory to be overridden.
        </p>
      </HelpSection>
      <HelpSection title="Launch and access the Anycloud VM">
        <p>Assuming the CLI and a named AWS credential are configured:</p>
        <pre>
          <code>{String.raw`anycloud vm ghcr.io/example/dev:latest \
  --credentials <aws-credential> --vm-type t3.large
anycloud ssh <vm-id>
anycloud ssh <vm-id> --host`}</code>
        </pre>
        <p>
          Keep files in <code>/workspace</code>. It is mounted on the container
          and host and survives container recreation and host reboot.
          Terminating the VM destroys the workspace; back up anything that must
          outlive it.
        </p>
        <p>
          The container receives the host Docker socket. Treat the VM as a
          single-user development environment with host control, not an
          isolation boundary for untrusted code. Choose a separate sandbox when
          that boundary is required.
        </p>
      </HelpSection>
    </HelpAnswer>
  );
}
