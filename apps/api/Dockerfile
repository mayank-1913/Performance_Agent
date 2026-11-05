# syntax=docker/dockerfile:1

# k6 binary source. Pin to a known version via --build-arg K6_IMAGE=grafana/k6:<tag>.
ARG K6_IMAGE=grafana/k6:latest
ARG NODE_IMAGE=node:20-bookworm-slim

FROM ${K6_IMAGE} AS k6

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
# better-sqlite3 falls back to compiling from source if no prebuilt binary matches.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker-runner/package.json apps/worker-runner/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace @perf/api --workspace @perf/worker-runner

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=k6 /usr/bin/k6 /usr/local/bin/k6
COPY --from=deps /app/node_modules ./node_modules
COPY apps/worker-runner ./apps/worker-runner
COPY apps/api ./apps/api

WORKDIR /app/apps/api
RUN mkdir -p storage logs && chown -R node:node /app/apps/api/storage /app/apps/api/logs

USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
