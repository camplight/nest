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
  && apt-get install -y --no-install-recommends haproxy tini curl ca-certificates git openssh-client \
  && rm -rf /var/lib/apt/lists/*

# GitHub CLI for Claude Code agents (pull requests, CI status); the .deb is checked against the release checksums.
ARG GH_VERSION=2.102.0
RUN arch="$(dpkg --print-architecture)" \
  && deb="gh_${GH_VERSION}_linux_${arch}.deb" \
  && cd /tmp \
  && curl -fsSLO "https://github.com/cli/cli/releases/download/v${GH_VERSION}/${deb}" \
  && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_checksums.txt" | grep " ${deb}$" | sha256sum -c - \
  && dpkg -i "${deb}" \
  && rm "${deb}" \
  && gh --version && git --version && ssh -V

# Claude Code for wrapped agents (docs/CLAUDE_CODE_AGENT.md); upgraded by changing this pin.
ARG CLAUDE_CODE_VERSION=2.1.309
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
  && npm cache clean --force \
  && claude --version

COPY --from=build /app /app
COPY docker/entrypoint.sh /usr/local/bin/nest-entrypoint
COPY deploy/nestsystem-bridge.mjs /app/deploy/nestsystem-bridge.mjs
COPY deploy/claude-code-bridge.mjs deploy/claude-code-proxy.mjs /app/deploy/

# Host source checkouts can have a private umask. Codex and Claude Code run as the node user.
RUN chmod 0755 /app/skills /app/skills/nest-management /app/skills/nest-management/scripts \
  && chmod 0644 /app/skills/nest-management/SKILL.md /app/skills/nest-management/scripts/* \
  && chmod 0755 /app/packages /app/packages/orgops-client /app/packages/orgops-client/src \
  && chmod 0644 /app/packages/orgops-client/src/wrapped-progress.mjs \
  && chmod 0755 /app/deploy && chmod 0644 /app/deploy/claude-code-bridge.mjs /app/deploy/claude-code-proxy.mjs
USER node
RUN node --input-type=module -e 'import {accessSync,constants} from "node:fs"; accessSync("/app/skills/nest-management/SKILL.md",constants.R_OK); await import("/app/skills/nest-management/scripts/manage.mjs"); await import("/app/skills/nest-management/scripts/capability.mjs"); await import("/app/packages/orgops-client/src/wrapped-progress.mjs"); await import("/app/deploy/claude-code-bridge.mjs"); await import("/app/deploy/claude-code-proxy.mjs"); console.log("Management skill and bridge helpers readable as runtime user")'
USER root

RUN chmod +x /usr/local/bin/nest-entrypoint

ENV NEST_COMPONENTS=api,runner,user-ui
EXPOSE 8787

VOLUME ["/app/.nest-data", "/app/.nest-product", "/app/files"]

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD curl -fsS http://127.0.0.1:8787/health || exit 1

ENTRYPOINT ["tini", "--", "/usr/local/bin/nest-entrypoint"]
