import React from 'react';
import {
  HelpAnswer,
  HelpSection,
  ShortAnswer,
} from '@site/src/components/HelpAnswer';

export default function Comparison(): React.ReactElement {
  return (
    <HelpAnswer
      title="Anycloud vs Azure Container Apps for HTTP services"
      description="Choose between an Anycloud Service on selected compute and Azure Container Apps with managed ingress, revisions, and autoscaling."
      datePublished="2026-10-08"
      dateModified="2026-10-08"
      sources={[
        {
          label: 'Azure Container Apps overview',
          href: 'https://learn.microsoft.com/en-us/azure/container-apps/overview',
        },
        {
          label: 'Anycloud workload documentation',
          href: '/platform/services',
        },
      ]}
      faqs={[
        {
          question: 'Does an Anycloud Service scale to zero?',
          answer:
            'No. Services remain running until termination or upgrade, and Anycloud does not currently provide replica autoscaling.',
        },
      ]}
    >
      <ShortAnswer>
        <p>
          Choose Azure Container Apps when you want Azure-managed container
          infrastructure, autoscaling, and revision traffic splitting. Choose an
          Anycloud Service when you want a published HTTP container on
          explicitly selected compute, with a stable URL and the same CLI used
          for Jobs and VMs.
        </p>
      </ShortAnswer>
      <HelpSection title="Compare scaling and updates">
        <p>
          Azure Container Apps provides managed HTTPS ingress, multiple
          application revisions, traffic splitting, and autoscaling based on
          HTTP traffic or other triggers. Most applications can scale to zero.
        </p>
        <p>
          Anycloud Services remain running until termination or upgrade.
          Anycloud currently has no replica autoscaling. A VM-backed Service
          upgrade preserves its public URL but replaces the workload with
          downtime. Choose based on those lifecycle requirements as well as the
          container image.
        </p>
      </HelpSection>
      <HelpSection title="Launch the HTTP image with Anycloud">
        <p>
          Assuming Anycloud and a named Azure credential are configured, replace
          the placeholders with a Service ID and an available Azure VM type:
        </p>
        <pre>
          <code>{String.raw`anycloud service ghcr.io/example/inference:latest \
  --id <service-id> \
  --credentials <azure-credential> \
  --vm-type <azure-vm-type>
anycloud status <service-id>
anycloud logs <service-id> --follow`}</code>
        </pre>
        <p>
          The image must start the server by default and listen on{' '}
          <code>0.0.0.0:$PORT</code>; the default port is 8088. With public
          ingress, the endpoint is{' '}
          <code>https://&lt;service-id&gt;.anycloud.sh</code>. Keep the compute
          target in an unattended command; omitting it with a named credential
          requires an interactive picker.
        </p>
        <p>
          Use a Service for a managed HTTP endpoint. Use a VM when the main
          requirement is interactive container and host access.
        </p>
      </HelpSection>
    </HelpAnswer>
  );
}
