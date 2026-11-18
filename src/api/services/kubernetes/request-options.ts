import { Observable, type ConfigurationOptions } from '@kubernetes/client-node';
import { assertRequestActive } from '../request-budget.js';

/** Preserve client authentication middleware while cancelling HTTP and body reads. */
export function kubernetesRequestOptions(
  signal?: AbortSignal,
): ConfigurationOptions | undefined {
  if (!signal) return undefined;
  return {
    middlewareMergeStrategy: 'append',
    middleware: [
      {
        pre(request) {
          assertRequestActive(signal);
          request.setSignal(signal);
          return new Observable(Promise.resolve(request));
        },
        post(response) {
          return new Observable(Promise.resolve(response));
        },
      },
    ],
  };
}
