# Nest UI rebrand

Implemented in `/Users/altras/home/dev/nest`, forked from the latest `camplight/orgops` main at `c78698d` (fetched September 23, 2026). The fork retains full upstream Git history, uses branch `nest/rebrand`, and has an `upstream` remote pointing to `git@github.com:camplight/orgops.git`. The existing `camplight/nest` repository is configured as `origin`. No changes have been pushed.

`/Users/altras/home/dev/orgops` was fast-forwarded to the same commit. Its pre-existing `.gitignore` and `package-lock.json` changes are preserved in the named stash `preserved before Nest fork update 2026-09-23`; untracked local files were retained. Backups of the first Nest implementation and original Git metadata are in `/tmp/nest-rebase-backup`.

The branding was ported onto the latest components, preserving realtime messages, markdown, attachments, channel sharing/management, first-login password setup, mobile drawers, API keys, and agent invites. Rebrand edits are left uncommitted for review.

## Design

Uses the supplied `/Users/altras/Pictures/Nest SEO` references: deep forest #021814, soft mist #EFF0F0, white #FEFEFE, lime #5DBC20, coral #FF5C35, Unbounded headings and Inter body type. Fonts and their licenses are bundled locally. The SVG mark is reconstructed from the supplied logo screenshot; an original vector export can replace it directly.

Figma node 766:99 could not be accessed through the available tools. This is a rebrand of the existing application screens based on the local references, not a verified pixel-exact implementation of that node. Reference-only features such as projects, community, and dashboard spending have not been added to the user messaging app.

## Changes

- Shared branding and light/dark tokens in `apps/nest-brand`.
- Both apps: Nest identity, local fonts, favicon, responsive login and persisted theme switch.
- User UI: forest sidebar, mist workspace, compact message surfaces, accessible message input and selected-channel state.
- Admin UI: branded navigation/header, shared theme across existing screens, dashboard metrics and responsive layout, login pending/error handling.
- Existing application workflows and API endpoints retained; package names and authentication identifiers use Nest, with legacy compatibility described in `docs/REBRANDING.md`.

## Run

```sh
npm run --workspace @nest/user-ui dev
npm run --workspace @nest/admin-ui dev
```

Both development servers expect the existing API at localhost:8787. All workspace dependencies are installed locally from the renamed lockfile. Nest no longer depends on the runloop checkout to build. Run `npm ci` to reproduce the installation.

## Verification

Both UI production builds and TypeScript checks passed. `smoke.mjs` runs browser checks with mocked API responses, including login, theme persistence, mobile overflow, channel filtering, message submission, the new-conversation dialog, mobile navigation, API keys, and agent invites. It writes the screenshots in this folder. It requires Playwright (or a module path via `NEST_PLAYWRIGHT`) and a compatible Chromium installation; set `NEST_CHROMIUM` to override this machine's installed browser path. Live backend integration was not exercised.

## Full product rename

The rebrand now includes the complete repository, CLI (`apps/cli`), npm workspaces, configuration, services, Docker deployment, and documentation. Dependencies for all workspaces are installed locally. See `docs/REBRANDING.md` for compatibility and full-suite results.
