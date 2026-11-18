export enum QuotaRequestStatus {
  Submitted = 'submitted',
  Approved = 'approved',
  Failed = 'failed',
  Skipped = 'skipped',
  Watching = 'watching',
  TimedOut = 'timed_out',
}

export enum QuotaOperationStatus {
  Queued = 'queued',
  Running = 'running',
  Completed = 'completed',
}

export enum QuotaOperationTargetStatus {
  Pending = 'pending',
  Running = 'running',
  Completed = 'completed',
}

export enum QuotaProviderStatus {
  Current = 'CURRENT',
  Approved = 'APPROVED',
  Partial = 'PARTIAL',
  Denied = 'DENIED',
  Queued = 'QUEUED',
  Running = 'RUNNING',
}
