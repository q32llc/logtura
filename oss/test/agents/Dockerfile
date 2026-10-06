FROM node:22-bookworm
RUN npm install --global @openai/codex@0.160.1 @anthropic-ai/claude-code@2.1.291
COPY consumer.mjs /consumer.mjs
ENTRYPOINT ["node", "/consumer.mjs"]
