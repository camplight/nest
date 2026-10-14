FROM node:22-bookworm-slim AS build

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY vendor/orgops ./vendor/orgops
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY skills ./skills
COPY docs ./docs
COPY README.md AGENTS.md tsconfig.base.json LICENSE LICENSING.md NOTICE ./
COPY LICENSES ./LICENSES
RUN chmod 0755 /app/LICENSES && chmod 0644 /app/LICENSE /app/LICENSING.md /app/NOTICE /app/LICENSES/*

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
COPY deploy/nestsystem-bridge.mjs /app/deploy/nestsystem-bridge.mjs

# Host source checkouts can have a private umask. Codex runs as the node user.
RUN chmod 0755 /app/skills /app/skills/nest-management /app/skills/nest-management/scripts \
  && chmod 0644 /app/skills/nest-management/SKILL.md /app/skills/nest-management/scripts/*
USER node
RUN node --input-type=module -e 'import {accessSync,constants} from "node:fs"; accessSync("/app/skills/nest-management/SKILL.md",constants.R_OK); await import("/app/skills/nest-management/scripts/manage.mjs"); await import("/app/skills/nest-management/scripts/capability.mjs"); console.log("Management skill and helpers readable as runtime user")'
USER root

RUN chmod +x /usr/local/bin/nest-entrypoint

ENV NEST_COMPONENTS=api,runner,user-ui
EXPOSE 8787

VOLUME ["/app/.nest-data", "/app/.nest-product", "/app/files"]

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD curl -fsS http://127.0.0.1:8787/health || exit 1

ENTRYPOINT ["tini", "--", "/usr/local/bin/nest-entrypoint"]
