/** The Deployment errors the API surface maps, kept free of kubernetes/. */
export class DeploymentDomainError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 400 | 404 | 409 | 503,
  ) {
    super(message);
    this.name = 'DeploymentDomainError';
  }
}

export class DeploymentWorkloadError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 400 | 401 | 403 | 404 | 409 | 503,
    public readonly code?:
      | 'CLIENT_VERSION_MISMATCH'
      | 'WORKLOAD_CANDIDATE_STALE'
      | 'WORKLOAD_EXECUTION_USED',
  ) {
    super(message);
    this.name = 'DeploymentWorkloadError';
  }
}
