FROM node:20.18.0-bullseye

RUN apt-get update && apt-get install -y --no-install-recommends \
    tmux sqlite3 \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g @anthropic-ai/claude-code

RUN groupadd -r hopper && useradd -r -g hopper -m -s /bin/bash hopper

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
  && mkdir -p /workspace /storage /data /home/hopper/.claude \
  && chown -R hopper:hopper /app /workspace /storage /data /home/hopper

USER hopper

EXPOSE 3000

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
