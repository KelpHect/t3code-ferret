# syntax=docker/dockerfile:1.7

FROM oven/bun:1.3.9 AS builder

WORKDIR /app

COPY . .

RUN bun install --frozen-lockfile
RUN bun run build
RUN bun install --frozen-lockfile --production

FROM node:24-bookworm-slim AS runtime

ARG CODEX_CLI_VERSION=latest

ENV NODE_ENV=production \
    T3_DEPLOYMENT_MODE=self-hosted \
    T3CODE_HOST=0.0.0.0 \
    T3CODE_PORT=3773 \
    DATA_ROOT=/data \
    T3CODE_NO_BROWSER=true

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git gosu tini \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app

COPY --from=builder /app /app
COPY docker/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN npm install --global "@openai/codex@${CODEX_CLI_VERSION}" \
    && codex --version \
    && git --version \
    && bun --version \
    && useradd --system --create-home --home-dir /home/t3code --shell /usr/sbin/nologin t3code \
    && mkdir -p /data \
    && chown -R t3code:t3code /app /data /home/t3code \
    && chmod 0755 /usr/local/bin/docker-entrypoint.sh

EXPOSE 3773

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 CMD-SHELL \
  curl -fsS "http://127.0.0.1:${T3CODE_PORT:-3773}/health/ready" || exit 1

ENTRYPOINT ["tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD []

