FROM node:22-bookworm-slim AS build

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY skills ./skills
COPY docs ./docs
COPY README.md AGENTS.md tsconfig.base.json ./

RUN npm ci
RUN VITE_UI_BASE_PATH=/admin/ npm run admin-ui:build
RUN VITE_UI_BASE_PATH=/ npm run user-ui:build

FROM node:22-bookworm-slim AS runtime

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends haproxy tini curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app /app
COPY docker/entrypoint.sh /usr/local/bin/nest-entrypoint

RUN chmod +x /usr/local/bin/nest-entrypoint

ENV NEST_COMPONENTS=api,runner,user-ui
EXPOSE 8787

VOLUME ["/app/.nest-data", "/app/files"]

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD curl -fsS http://127.0.0.1:8787/health || exit 1

ENTRYPOINT ["tini", "--", "/usr/local/bin/nest-entrypoint"]
