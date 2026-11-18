# The `user-namespace` pool check's images (RFC 0049 C32): Docker's engine,
# run as root, as a user with passwordless sudo, and as one without. None
# moves its own processes out of the cgroup root, as docker:dind's entrypoint
# does: the runner must. The runner needs a non-empty Entrypoint and Cmd.
FROM mirror.gcr.io/library/docker:27-dind@sha256:aa3df78ecf320f5fafdce71c659f1629e96e9de0968305fe1de670e0ca9176ce AS root
RUN apk add --no-cache curl perl sudo util-linux
ENTRYPOINT ["/usr/bin/env"]
CMD ["true"]

FROM root AS sudo
RUN adduser -D -u 1000 job && echo 'job ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/job
USER job

FROM root AS no-sudo
RUN adduser -D -u 1000 job
USER job
