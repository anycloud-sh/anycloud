import React, { type ReactNode } from 'react';

import SlackMessagePreview from './SlackMessagePreview';

type SlackVmReleaseAlertProps = {
  compact?: boolean;
};

export default function SlackVmReleaseAlert({
  compact = false,
}: SlackVmReleaseAlertProps): ReactNode {
  return (
    <SlackMessagePreview
      ariaLabel="Example Slack alert for delayed VM releases"
      bulleted
      compact={compact}
      lines={[
        '3 VMs across 2 workloads remain unreleased; the oldest has been waiting 18m since Anycloud requested removal.',
        'The provider may continue billing until release is confirmed. Anycloud will keep retrying cleanup.',
        <>
          Affected workloads: <code>training-h100-west</code>,{' '}
          <code>model-eval-42</code>.
        </>,
      ]}
      source="API: production.anycloud.sh · @alice"
      title="anycloud: VM release delayed"
    />
  );
}
