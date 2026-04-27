FROM node:22-slim

RUN apt-get update && apt-get install -y \
    git curl ca-certificates python3 make g++ tmux ssh openssh-client jq \
    ffmpeg zip unzip rsync sqlite3 tree tini \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*

# Install Docker CLI (for remote Docker access via SSH)
RUN curl -fsSL https://download.docker.com/linux/static/stable/$(uname -m)/docker-27.5.1.tgz \
    | tar xz --strip-components=1 -C /usr/local/bin docker/docker \
    && mkdir -p /usr/local/lib/docker/cli-plugins \
    && curl -fsSL "https://github.com/docker/compose/releases/download/v2.32.4/docker-compose-linux-$(uname -m)" \
       -o /usr/local/lib/docker/cli-plugins/docker-compose \
    && chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# Install Qdrant vector database
RUN curl -fsSL https://github.com/qdrant/qdrant/releases/download/v1.17.1/qdrant-x86_64-unknown-linux-musl.tar.gz \
    | tar xz -C /usr/local/bin && chmod +x /usr/local/bin/qdrant

# Install AI CLIs
RUN npm install -g @anthropic-ai/claude-code @google/gemini-cli @openai/codex

# Reuse the existing 'node' user (UID 1000) — rename to workbench, home at /data
RUN usermod -l workbench -d /data -m node && \
    groupmod -n workbench node && \
    mkdir -p /data/.claude /data/.workbench /data/workspace && \
    chown -R workbench:workbench /data

# Copy and install app dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && chown -R workbench:workbench /app

# Copy app source
COPY --chown=workbench:workbench . .

# Entrypoint sets up /data structure at runtime (volume may be empty on first run)
COPY --chown=workbench:workbench entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER workbench

ENV HOME=/data
ENV WORKBENCH_DATA=/data/.workbench
ENV WORKSPACE=/data/workspace
ENV CLAUDE_CONFIG_DIR=/data/.claude
ENV PORT=7860

WORKDIR /data
EXPOSE 7860

ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
CMD ["node", "/app/server.js"]
