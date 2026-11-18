import { cliArgs, type CliOptions } from './cli-surface.js';
import type { CredentialManager } from './credentials.js';
import type { WorkloadCliCreateTransport } from './workload-mutations.js';
import type { ProviderProfiles, VmProvider } from './profiles.js';
import type {
  PersistentVmSubmission,
  PersistentVmTarget,
} from './targets/persistent-vm-types.js';

function isPublicVmProvider(target: PersistentVmTarget): target is VmProvider {
  return target !== 'local-smolvm';
}

export interface PersistentVmSubmissionDependencies {
  readonly credentials: Pick<CredentialManager, 'save'>;
  readonly mutations: WorkloadCliCreateTransport;
  readonly profiles: Pick<ProviderProfiles, 'vm'>;
}

export async function submitPersistentVm(
  target: PersistentVmTarget,
  request: PersistentVmSubmission,
  dependencies: PersistentVmSubmissionDependencies,
): Promise<void> {
  let placement: Pick<
    CliOptions<'vm'>,
    'credentials' | 'vm-type' | 'region' | 'disk-size'
  > = {};
  if (isPublicVmProvider(target)) {
    const profile = dependencies.profiles.vm(target);
    await dependencies.credentials.save(
      profile.credentialName,
      profile.credential,
    );
    placement = {
      credentials: profile.credentialName,
      'vm-type': profile.vmTypes,
      region: profile.region,
      'disk-size':
        profile.diskSizeGb === undefined
          ? undefined
          : String(profile.diskSizeGb),
    };
  }
  const args = cliArgs(
    'vm',
    {
      id: request.ref.id,
      env: `VM_SMOKE_ENV_MARKER=${request.environmentMarker}`,
      secret: request.secretName,
      ...placement,
    },
    [request.image],
  );

  await dependencies.mutations.runCliCreateWithTransientRetries(
    request.ref,
    args,
    {
      timeoutMs: 180_000,
      label: `${target}-persistent-vm-submission`,
    },
  );
}
