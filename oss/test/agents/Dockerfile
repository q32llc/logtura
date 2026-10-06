FROM node:22-bookworm
RUN apt-get update && apt-get install --yes --no-install-recommends git-lfs && rm -rf /var/lib/apt/lists/* && git lfs install --system
RUN npm install --global @openai/codex@0.160.1 @anthropic-ai/claude-code@2.1.291
COPY consumer.mjs /consumer.mjs
ENTRYPOINT ["node", "/consumer.mjs"]
