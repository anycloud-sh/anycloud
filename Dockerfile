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
# The runner is compiled the way the CLI is (release/build-binaries.sh). It
# embeds the Bun runtime and no npm package; rclone sits beside it. The image's
# Node packages keep their own licence files under node_modules/.
RUN yarn build && npx bun build --compile ./dist/runner/index.js --outfile /app/anycloud-runner \
  && bun_version="$(node -p "require('./node_modules/bun/package.json').version")" \
  && { cat NOTICE; printf '\nThe runner in /opt/anycloud-runner embeds Bun %s; that directory also holds\nrclone, tini, the GNU C Library and a CA bundle. Their licences follow.\n\n' "$bun_version"; \
    cat "release/licenses/bun-$bun_version-LICENSE.md" release/licenses/rclone-*-COPYING; } >/app/NOTICE.image

# What `runner-install` copies into each managed replica (RFC 0044): the
# runner, tini as its PID 1, rclone and a CA bundle for it, pinned as the VM
# host's rclone is (src/api/runtime-artifacts.ts). Job images may lack glibc
# or CA certificates, so the runner carries its loader and libraries: its
# interpreter and DT_RPATH point beside it (DT_RPATH, unlike DT_RUNPATH,
# outranks an image's LD_LIBRARY_PATH). patchelf 0.18 corrupted the Bun
# bundle when it set both in one pass, so it sets them in two. 0.19.3 is
# the first release that updates DT_VERDEF when it moves .gnu.version_d;
# 0.18 left it stale, which glibc faulted on under ARM64's 64 KiB pages.
FROM base AS runner
ARG TARGETARCH
ARG RCLONE_VERSION=1.68.2
ARG PATCHELF_VERSION=0.19.3
COPY --from=builder /app/anycloud-runner /opt/anycloud-runner/anycloud-runner
COPY --from=builder /app/NOTICE.image /NOTICE
WORKDIR /opt/anycloud-runner
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip tini && rm -rf /var/lib/apt/lists/* \
  && case "$TARGETARCH" in \
    amd64) arch=x86_64; rclone_sha=0e6fa18051e67fc600d803a2dcb10ddedb092247fc6eee61be97f64ec080a13c; patchelf_sha=38861b171079e440b25ac86483284f690d0ee7921dba98b0c8fe04a9b0a11667 ;; \
    arm64) arch=aarch64; rclone_sha=c6e9d4cf9c88b279f6ad80cd5675daebc068e404890fa7e191412c1bc7a4ac5f; patchelf_sha=2281dd071995b449b9ce7c53c71d6d56ec3a280ae1cc66b779442abf624f7c10 ;; \
  esac \
  && curl -fsSL --retry 5 --retry-all-errors --retry-delay 5 -o /tmp/rclone.zip "https://downloads.rclone.org/v${RCLONE_VERSION}/rclone-v${RCLONE_VERSION}-linux-${TARGETARCH}.zip" \
  && echo "$rclone_sha  /tmp/rclone.zip" | sha256sum -c - \
  && unzip -j /tmp/rclone.zip '*/rclone' -d . \
  && curl -fsSL --retry 5 --retry-all-errors --retry-delay 5 -o /tmp/patchelf.tgz "https://github.com/NixOS/patchelf/releases/download/${PATCHELF_VERSION}/patchelf-${PATCHELF_VERSION}-${arch}.tar.gz" \
  && echo "$patchelf_sha  /tmp/patchelf.tgz" | sha256sum -c - \
  && mkdir /tmp/patchelf && tar -xzf /tmp/patchelf.tgz -C /tmp/patchelf \
  && cp /usr/bin/tini-static tini && cp /etc/ssl/certs/ca-certificates.crt . \
  && for lib in $(ldd anycloud-runner | grep -o '/[^ ]*'); do cp -L "$lib" .; done \
  && loader="$(/tmp/patchelf/bin/patchelf --print-interpreter anycloud-runner)" \
  && /tmp/patchelf/bin/patchelf --force-rpath --set-rpath /opt/anycloud-runner anycloud-runner \
  && /tmp/patchelf/bin/patchelf --set-interpreter "/opt/anycloud-runner/$(basename "$loader")" anycloud-runner \
  && glibc="$(dpkg-query -W -f '${Version}' libc6)" \
  && { printf '\nIn that directory, tini %s is under the MIT License; the GNU C\nLibrary %s, under the LGPL-2.1 (source:\nhttps://sources.debian.org/src/glibc/%s/); and the CA bundle from\nca-certificates %s, under the MPL-2.0. Their Debian copyright files and the\nLGPL-2.1 follow.\n\n' \
      "$(dpkg-query -W -f '${Version}' tini)" "$glibc" "$glibc" "$(dpkg-query -W -f '${Version}' ca-certificates)"; \
    cat /usr/share/doc/tini/copyright /usr/share/doc/libc6/copyright /usr/share/doc/ca-certificates/copyright /usr/share/common-licenses/LGPL-2.1; } >>/NOTICE

# The runner starts in an image without glibc, even with a foreign libc on
# LD_LIBRARY_PATH, and in one with nothing but its own directory; rclone
# verifies TLS with its own CA bundle in an image without one. The API image
# copies the directory from the last check, so a failing check fails the
# build.
FROM mirror.gcr.io/library/alpine:3.20 AS runner-musl-check
COPY --from=runner /opt/anycloud-runner /opt/anycloud-runner
RUN mkdir /tmp/decoy && echo decoy > /tmp/decoy/libc.so.6 \
  && { env -i LD_LIBRARY_PATH=/tmp/decoy /opt/anycloud-runner/anycloud-runner 2>&1; true; } | tee /tmp/err \
  && grep -q 'ANYCLOUD_RUNNER_WORKDIR_COPY is not set' /tmp/err
FROM gcr.io/distroless/static-debian12:debug AS runner-static-check
SHELL ["/busybox/sh", "-c"]
COPY --from=runner-musl-check /opt/anycloud-runner /opt/anycloud-runner
RUN { env -i /opt/anycloud-runner/anycloud-runner 2>&1; true; } | tee /tmp/err \
  && grep -q 'ANYCLOUD_RUNNER_WORKDIR_COPY is not set' /tmp/err
FROM mirror.gcr.io/library/ubuntu:24.04 AS runner-check
COPY --from=runner-static-check /opt/anycloud-runner /opt/anycloud-runner
RUN [ ! -e /etc/ssl/certs/ca-certificates.crt ] \
  && SSL_CERT_FILE=/opt/anycloud-runner/ca-certificates.crt /opt/anycloud-runner/rclone lsf --http-url https://downloads.rclone.org :http: >/dev/null

# Clean runtime stage — same pinned node image as the base stage (see top).
FROM ${NODE_IMAGE}
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client tini && rm -rf /var/lib/apt/lists/*
COPY package.json yarn.lock ./
COPY --from=deps-prod /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/migrations ./migrations
COPY --from=builder /app/LICENSE ./LICENSE
COPY --from=runner /NOTICE ./NOTICE
COPY --from=runner-check /opt/anycloud-runner /opt/anycloud-runner
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
