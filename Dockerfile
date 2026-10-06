FROM node:24-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bubblewrap socat ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
  && ln -s /app/node_modules/@anthropic-ai/claude-agent-sdk-linux-*/claude /usr/local/bin/claude
COPY src ./src
COPY managed-settings.json /etc/claude-code/managed-settings.json

ENV CLAUDE_CONFIG_DIR=/claude-home
RUN mkdir /claude-home /workspace && chown node:node /claude-home /workspace
USER node
WORKDIR /workspace
CMD ["node", "/app/src/main.ts"]
