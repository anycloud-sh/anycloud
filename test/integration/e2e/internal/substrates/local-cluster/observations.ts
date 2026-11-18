import {
  executeLocalKubernetesCommand,
  localKubernetesCommandSucceeds,
} from './command.js';
import { clusterLocalK3sImage as localKubernetesK3sImage } from './constants.js';

export async function requireLocalKubernetesTools(): Promise<void> {
  await executeLocalKubernetesCommand('docker', ['version'], {
    timeoutMs: 15_000,
  });
}

export async function warmLocalKubernetesImage(): Promise<void> {
  if (
    await localKubernetesCommandSucceeds('docker', [
      'image',
      'inspect',
      localKubernetesK3sImage,
    ])
  ) {
    return;
  }
  await executeLocalKubernetesCommand('docker', [
    'pull',
    localKubernetesK3sImage,
  ]);
}
