ARG API_IMAGE=anycloud-api-test
FROM ${API_IMAGE}

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-server \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /run/sshd /root/.ssh \
    && chmod 0700 /root/.ssh

COPY authorized_keys /root/.ssh/authorized_keys
RUN chmod 0600 /root/.ssh/authorized_keys

CMD ["/usr/sbin/sshd", "-D", "-e"]
