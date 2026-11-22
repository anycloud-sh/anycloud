import {
  SystemReleaseRefusedError,
  SystemReleaseStaleError,
  SystemReleaseUnavailableError,
} from '../services/system-release-domain.js';
import { SelfDeleteRefusedError } from '../services/self-delete.js';
import { declaredAs, mapDeclaredErrors } from './errors.js';
import { releaseWindowAuthenticatedImplementation as authenticated } from './base.js';

export const systemReleaseRouter = {
  selfDelete: authenticated.systemRelease.selfDelete.handler(
    ({ context, input, errors }) =>
      mapDeclaredErrors(
        () => context.domains.systemRelease.selfDelete(context.actor, input),
        [
          declaredAs(SelfDeleteRefusedError, errors.SELF_DELETE_REFUSED),
          declaredAs(
            SystemReleaseUnavailableError,
            errors.SYSTEM_RELEASE_UNAVAILABLE,
          ),
        ],
      ),
  ),
  selfDeleteStatus: authenticated.systemRelease.selfDeleteStatus.handler(
    ({ context, errors }) =>
      mapDeclaredErrors(
        () => context.domains.systemRelease.selfDeleteStatus(context.actor),
        [
          declaredAs(
            SystemReleaseUnavailableError,
            errors.SYSTEM_RELEASE_UNAVAILABLE,
          ),
        ],
      ),
  ),
  request: authenticated.systemRelease.request.handler(
    ({ context, input, signal, errors }) =>
      mapDeclaredErrors(
        () =>
          context.domains.systemRelease.request(context.actor, input, signal),
        [
          declaredAs(SystemReleaseRefusedError, errors.SYSTEM_RELEASE_REFUSED),
          declaredAs(SystemReleaseStaleError, errors.SYSTEM_RELEASE_STALE),
          declaredAs(
            SystemReleaseUnavailableError,
            errors.SYSTEM_RELEASE_UNAVAILABLE,
          ),
        ],
      ),
  ),
  kubernetes: authenticated.systemRelease.kubernetes.handler(
    ({ context, input, errors }) =>
      mapDeclaredErrors(
        () => context.domains.systemRelease.kubernetes(context.actor, input),
        [
          declaredAs(SystemReleaseRefusedError, errors.SYSTEM_RELEASE_REFUSED),
          declaredAs(
            SystemReleaseUnavailableError,
            errors.SYSTEM_RELEASE_UNAVAILABLE,
          ),
        ],
      ),
  ),
  backup: authenticated.systemRelease.backup.handler(({ context, errors }) =>
    mapDeclaredErrors(
      () => context.domains.systemRelease.backup(context.actor),
      [
        declaredAs(
          SystemReleaseUnavailableError,
          errors.SYSTEM_RELEASE_UNAVAILABLE,
        ),
      ],
    ),
  ),
  status: authenticated.systemRelease.status.handler(
    ({ context, signal, errors }) =>
      mapDeclaredErrors(
        () => context.domains.systemRelease.status(context.actor, signal),
        [
          declaredAs(
            SystemReleaseUnavailableError,
            errors.SYSTEM_RELEASE_UNAVAILABLE,
          ),
        ],
      ),
  ),
};
