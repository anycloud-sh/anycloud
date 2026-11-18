# syntax=docker/dockerfile:1

# Dependency layers are expensive (notably the better-sqlite3 native compile)
# and the per-release version bump in package.json busts the COPY layer, forcing a
# from-scratch reinstall every release. To avoid that, both installs can be served
# from prebuilt base images keyed by the yarn.lock hash (built by build-deps-base.yml).
# These args default to the local inline stages below, so a plain `docker build` with
# no prebuilt base still works (the fallback used by PRs, dep changes, and tests).
ARG DEPS_FULL_IMAGE=deps-full-inline   # release overrides with ghcr.io/anycloud-sh/api-deps-full:<lockhash>
ARG DEPS_PROD_IMAGE=deps-prod-inline   # release overrides with ghcr.io/anycloud-sh/api-deps-prod:<lockhash>
ARG NODE_IMAGE=mirror.gcr.io/library/node:22.22.3-slim@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752

# Node runtime pinned to 22.22.3. The floating node:22-slim moved to 22.23.0,
# which regressed node-fetch@2's gzip handling and broke the GCS service-account
# OAuth path (ERR_STREAM_PREMATURE_CLOSE) used by @google-cloud/storage in the API
# (Compute is unaffected — newer gaxios stack). 22.22.3 is the last release where
# the storage auth path works. BAND-AID: unpin (back to a floating 22.x) once the
# GCS client forces an uncompressed token request; until then bump the patch
# deliberately for node security. The digest is Docker's official multi-arch
# image served through Google's Docker Hub mirror so shared CI egress does not
# consume Docker Hub's anonymous pull quota. Keep both stages on NODE_IMAGE.
# Shared base with build tools for native modules (better-sqlite3)
FROM ${NODE_IMAGE} AS base
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
# node-gyp compiles against the headers the image ships under /usr/local/include/node
# instead of downloading them from nodejs.org, a download that aborted mid-build.
ENV npm_config_nodedir=/usr/local

# Inline full-dependency install — fallback for the builder when no prebuilt base
# is supplied. Byte-identical to what api-deps-full bakes. `yarn cache clean` in the
# same layer drops the ~1.3 GB yarn cache (not needed at build or runtime) so the
# prebuilt base stays small: a reuse build pulls BOTH bases, and the cache bloat was
# exhausting CI runner disk ("no space left on device") while extracting them.
FROM base AS deps-full-inline
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile && yarn cache clean

# Inline production-dependency install — fallback for the runtime when no prebuilt
# base is supplied. Byte-identical to what api-deps-prod bakes. Uses yarn's own
# --production resolution (lockfile-faithful); do NOT swap for `npm prune`, which
# re-resolves off yarn.lock and upgrades runtime deps.
FROM base AS deps-prod-inline
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --production --frozen-lockfile && yarn cache clean

# Resolve dependency trees: each is either the local inline stage above, or an
# external prebuilt base. The unreferenced inline stage is pruned by BuildKit.
FROM ${DEPS_FULL_IMAGE} AS deps-full
FROM ${DEPS_PROD_IMAGE} AS deps-prod

# Builder stage - rebuilds when source changes
FROM deps-full AS builder
WORKDIR /app
COPY . .
RUN yarn build

# Clean runtime stage — same pinned node image as the base stage (see top).
FROM ${NODE_IMAGE}
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client tini && rm -rf /var/lib/apt/lists/*
COPY package.json yarn.lock ./
COPY --from=deps-prod /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/migrations ./migrations
COPY --from=builder /app/LICENSE ./LICENSE
COPY --from=builder /app/NOTICE ./NOTICE
# The digest-pinned chart this image installs and upgrades to
# (`yarn -s chart:publish <version>` prints it); bootstrap and upgrades read
# it from the image config. Last, so a new chart reuses every layer above.
ARG API_CHART=
ENV ANYCLOUD_API_CHART=${API_CHART}
EXPOSE 8080
# Background ControlMasters fork beyond Node's tracked child and become PID 1's
# responsibility; Tini adopts and reaps them. Deliberately no `-g`: a master
# setsids into its own session, so a group signal never reaches one and would
# only kill the in-flight command clients that Node's shutdown already owns.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "./dist/api/server.js"]
