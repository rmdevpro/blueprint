FROM node:20.18.0-bullseye

RUN apt-get update && apt-get install -y --no-install-recommends \
    tmux sqlite3 \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd -r hopper && useradd -r -g hopper -m -s /bin/bash hopper

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /workspace /storage /home/hopper/.claude \
  && echo '{"hasCompletedOnboarding":true}' > /home/hopper/.claude/.claude.json \
  && chown -R hopper:hopper /app /workspace /storage /home/hopper

USER hopper

EXPOSE 3000

CMD ["node", "server.js"]
