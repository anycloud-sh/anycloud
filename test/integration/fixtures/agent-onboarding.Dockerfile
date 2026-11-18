# One S1 onboarding session: a privileged container with its own Docker
# daemon, an empty HOME and the pinned agent CLIs. Nothing from the host is
# mounted; the suite copies in only the minted AWS profile and agent login.
# The agent runs as the non-root `agent`, which reaches dockerd as a member of
# the docker group, so the installer uses ~/.local/bin as SKILL.md documents.
FROM node:22-bookworm
RUN apt-get update \
    && apt-get install -y --no-install-recommends docker.io iptables procps ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
ARG CLAUDE_CODE_VERSION
ARG CODEX_VERSION
RUN npm install --global "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}"
RUN useradd --create-home --home-dir /home/agent --groups docker agent \
    && mkdir /home/agent/work && chown agent:agent /home/agent/work
VOLUME /var/lib/docker
CMD ["sh", "-c", "dockerd > /var/log/dockerd.log 2>&1 & exec sleep infinity"]
