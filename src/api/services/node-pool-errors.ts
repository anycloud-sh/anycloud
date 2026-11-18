/** The node pool errors the API surface maps, kept free of kubernetes/. */
export class NodePoolsUnavailableError extends Error {
  constructor() {
    super(
      'This Anycloud API has no running cluster; create one with anycloud cluster create before creating a node pool',
    );
    this.name = 'NodePoolsUnavailableError';
  }
}

export class NodePoolAlreadyExistsError extends Error {
  constructor(
    public readonly identifier: string,
    reason = 'already exists',
  ) {
    super(`Node pool "${identifier}" ${reason}`);
    this.name = 'NodePoolAlreadyExistsError';
  }
}

export class NodePoolCredentialNotFoundError extends Error {
  constructor(public readonly credentialName: string) {
    super(`Credential "${credentialName}" not found`);
    this.name = 'NodePoolCredentialNotFoundError';
  }
}

export class NodePoolNotFoundError extends Error {
  constructor(public readonly identifier: string) {
    super(`Node pool "${identifier}" not found`);
    this.name = 'NodePoolNotFoundError';
  }
}

export class NodePoolReferencedError extends Error {
  constructor() {
    super(
      'Node pool still has live references; delete the Deployments and Workloads that target it first',
    );
    this.name = 'NodePoolReferencedError';
  }
}

export class NodePoolZoneInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NodePoolZoneInvalidError';
  }
}

export class NodePoolClusterIncompatibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NodePoolClusterIncompatibleError';
  }
}

export class ClusterNotAcceptingError extends Error {
  constructor(public readonly clusterId: string) {
    super(`cluster ${clusterId} is deleting and does not accept node pools`);
    this.name = 'ClusterNotAcceptingError';
  }
}
