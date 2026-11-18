# Azure onboarding runner-loss qualification

Dispatch `Integration Tests` with `azure_runner_loss` enabled. The subscription
must have the shared AnyCloud storage account in `anycloud-storage`; a read-only
preflight verifies it before generating an identity. The qualification uses the
existing generator and owns only one marked smoke container.

The creator authenticates as the generated principal in an isolated child. After
container creation, its controller kills the process group, removes every home,
temporary, Azure CLI, application, SQLite, and XDG state file, and confirms the
root is gone. Only a readiness signal crosses IPC; no secret or artifact is
handed to recovery. Creation failures remain visible alongside cleanup failures.

A separate job reconstructs names from repository, `GITHUB_RUN_ID`, and
`GITHUB_RUN_ATTEMPT`. GitHub must independently confirm the exact workflow,
commit, attempt, and completed creator job before Azure login. Recovery validates
provider markers, removes the container, confirms absence, then removes grants
and directory identity. It runs twice in fresh processes. Shared infrastructure
and unrelated resources survive; legacy sweeps exclude `onb-run-*`.

Uncertain absence or ambiguous ownership retains the identity. An app without a
discoverable principal requires reconciliation because orphaned grants cannot be
ruled out. A new attempt cannot recover an earlier attempt, and cancelling the
whole workflow can prevent recovery from being scheduled. This is a controlled
Azure qualification, not general generated-cloud activation.
