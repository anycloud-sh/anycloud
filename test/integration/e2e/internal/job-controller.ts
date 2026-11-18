import type { ApiClient } from './api.js';

export type JobControllerBinding = ApiClient['controller'];

/** Job generations retain the controller that owns their credentials and records. */
export function jobControllerBinding(
  api: Pick<ApiClient, 'controller'>,
): JobControllerBinding {
  return Object.freeze({ ...api.controller });
}

export function assertJobController(
  api: Pick<ApiClient, 'controller'>,
  original: JobControllerBinding,
): void {
  const current = api.controller;
  if (
    current.url !== original.url ||
    current.generation !== original.generation
  )
    throw new Error('Job requires its original controller');
}
