FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git ripgrep python3 python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global @openai/codex@0.150.1 \
    && codex --version | grep -Fx 'codex-cli 0.150.1' \
    && useradd --uid 10001 --create-home worker \
    && mkdir -p /broker /workspace /config \
    && chown 10001:10001 /broker /workspace
COPY gateway.mjs worker.mjs transport-policy.mjs dependency-proxy.mjs /opt/gs/
USER 10001:10001
WORKDIR /workspace
ENV HOME=/tmp/home CODEX_HOME=/tmp/home/.codex
ENTRYPOINT ["node", "/opt/gs/worker.mjs"]
