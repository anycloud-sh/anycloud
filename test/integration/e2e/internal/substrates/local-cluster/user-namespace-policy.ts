import type { KubernetesClients } from '../../../../../../src/api/services/kubernetes/client.js';
import { USER_NAMESPACE_RUNTIME_CLASS } from '../../../../../../src/api/services/kubernetes/user-namespace.js';

/**
 * RFC 0049 C32's ValidatingAdmissionPolicy, from the installer's admin
 * connection: a Pod of the class without `hostUsers: false`, or with a
 * privileged container, is refused. Dry runs pass admission and change
 * nothing; the compliant control is admitted, so a missing RuntimeClass or
 * another refusal can't pass as the policy's.
 */
export async function assertUserNamespacePolicy(
  clients: KubernetesClients,
): Promise<void> {
  const admit = (hostUsers: boolean | undefined, privileged: boolean) =>
    clients.core
      .createNamespacedPod({
        namespace: 'default',
        dryRun: 'All',
        body: {
          metadata: { name: 'c32-policy' },
          spec: {
            runtimeClassName: USER_NAMESPACE_RUNTIME_CLASS,
            hostUsers,
            containers: [
              {
                name: 'main',
                image: 'mirror.gcr.io/library/busybox:1.36',
                securityContext: { privileged },
              },
            ],
          },
        },
      })
      .then(
        () => 'admitted',
        (error: unknown) => String((error as { body?: unknown }).body ?? error),
      );
  const outcomes = [
    await admit(false, false),
    await admit(undefined, false),
    await admit(false, true),
  ];
  const denied = "ValidatingAdmissionPolicy 'anycloud-user-namespace'";
  if (
    outcomes[0] !== 'admitted' ||
    !outcomes.slice(1).every((outcome) => outcome.includes(denied))
  ) {
    throw new Error(
      `The policy must admit only the compliant Pod: ${outcomes.join(' | ')}`,
    );
  }
}
