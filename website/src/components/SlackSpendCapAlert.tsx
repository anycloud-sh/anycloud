import React, { type ReactNode } from 'react';

import SlackMessagePreview from './SlackMessagePreview';

type SlackSpendCapAlertProps = {
  compact?: boolean;
  title?: ReactNode;
  lines?: ReactNode[];
};

export default function SlackSpendCapAlert({
  compact = false,
  title = 'anycloud: workloads waiting on spend cap',
  lines = [
    <>
      blocked by daily budget (agent-session &apos;csp-rank&apos;): spent $4,224
      / $4,000 - resumes 2026-05-29 00:00 UTC
    </>,
  ],
}: SlackSpendCapAlertProps): ReactNode {
  return (
    <SlackMessagePreview
      ariaLabel="Example Slack spend cap alert"
      compact={compact}
      lines={lines}
      title={title}
    />
  );
}
