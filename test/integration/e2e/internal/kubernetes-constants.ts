export const kubernetesE2EServeImage =
  'mirror.gcr.io/library/nginx:alpine@sha256:db35bfc6b2951e7f8a72db5db120288c127ffaeeb4a6d4b95a26fead017d5913';
/**
 * A Service container must listen on `$PORT` (default 8088): the product
 * probes that port for readiness and the Service is Running only once the
 * probe passes. nginx ignores `$PORT` and listens on 80, so every Service
 * created from this image is told `PORT=80`.
 */
export const kubernetesE2EServePort = 80;
