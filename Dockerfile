FROM node:22-slim

RUN apt-get update && apt-get install -y \
    git curl ca-certificates python3 make g++ tmux ssh openssh-client gosu jq sudo \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 \
    libpango-1.0-0 libcairo2 libasound2 libxshmfence1 \
    && rm -rf /var/lib/apt/lists/*

# Install Docker CLI (for building/deploying from within sessions)
RUN curl -fsSL https://download.docker.com/linux/static/stable/$(uname -m)/docker-27.5.1.tgz \
    | tar xz --strip-components=1 -C /usr/local/bin docker/docker \
    && mkdir -p /usr/local/lib/docker/cli-plugins \
    && curl -fsSL "https://github.com/docker/compose/releases/download/v2.32.4/docker-compose-linux-$(uname -m)" \
       -o /usr/local/lib/docker/cli-plugins/docker-compose \
    && chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# Install Qdrant vector database
RUN curl -fsSL https://github.com/qdrant/qdrant/releases/download/v1.17.1/qdrant-x86_64-unknown-linux-musl.tar.gz \
    | tar xz -C /usr/local/bin && chmod +x /usr/local/bin/qdrant

# Install Claude CLI and Playwright MCP
ARG NPM_REGISTRY=http://192.168.1.110:4873
RUN npm config set registry ${NPM_REGISTRY}
RUN npm install -g @anthropic-ai/claude-code @playwright/mcp
RUN npx playwright install chrome

# Copy and install app dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy app source
COPY . .

# Create non-root user (Claude CLI refuses --dangerously-skip-permissions as root)
RUN useradd -m -s /bin/bash blueprint && \
    mkdir -p /home/blueprint/.claude /home/blueprint/.blueprint /home/blueprint/workspace && \
    chown -R blueprint:blueprint /home/blueprint /app && \
    echo 'blueprint ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/blueprint

# Pre-create settings to skip bypass permissions prompt and onboarding
RUN mkdir -p /home/blueprint/.claude && \
    echo '{"skipDangerousModePermissionPrompt":true,"hasCompletedOnboarding":true,"theme":"dark","preferredTheme":"dark"}' > /home/blueprint/.claude/settings.json && \
    echo '{"skipDangerousModePermissionPrompt":true,"hasCompletedOnboarding":true,"theme":"dark","hasPickedTheme":true,"preferredTheme":"dark"}' > /home/blueprint/.claude/settings.local.json && \
    chown -R blueprint:blueprint /home/blueprint

# Entrypoint ensures runtime directories exist after volume mounts
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV HOME=/home/blueprint
ENV BLUEPRINT_DATA=/home/blueprint/.blueprint
ENV WORKSPACE=/home/blueprint/workspace

WORKDIR /home/blueprint/workspace
EXPOSE 3000

# Entrypoint runs as root to handle docker socket permissions, then drops to blueprint via gosu
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "/app/server.js"]
