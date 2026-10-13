# Dashboard validation screenshots

Captured 2026-10-13 after product tests, lint, builds and browser regressions passed.
All accounts, projects, task briefs, deliverables and community packages are
synthetic test data. No production account/content/credentials are published.

Before images render Dashboard/App/CSS from deployed commit
`192dd85a8fca3e1d5a6d389a898d7f9ea683effa` with the same synthetic seeded
projects. After images render this branch. Figma is a design reference, not the
source of application screenshots. See [design acceptance and differences](../../../DASHBOARD_DESIGN.md).

- `dashboard-before-desktop.png`, `dashboard-before-mobile.png`: previous layout.
- `dashboard-desktop.png`: live pending review, active stack, revision, catalog.
- `dashboard-mobile-top.png`: responsive metric cards and search.
- `dashboard-mobile-work.png`: project/review actions on mobile.
- `dashboard-mobile-community.png`: original art with real package detail links.
- `dashboard-dark-desktop.png`: dark theme.
- `dashboard-empty-desktop.png`, `dashboard-empty-mobile.png`: no accessible projects.
- `dashboard-error-mobile.png`: summary outage clears metrics and offers Retry.

Verification: 86 product tests; full npm lint; both UI builds; project/dashboard,
community, Google auth, personal onboarding, agent/model and mention browser suites.
The dashboard scenario uses real Nest and unchanged OrgOps HTTP handlers, real
human-selected deliverables/reviews and changed engine channel access. It tests
keyboard navigation, search, task/catalog links, history/reload, original asset
loading, retry and viewport overflow. WebSocket transport is disabled only in
this deterministic visual scenario; the product/mention suites test the actual
WebSocket and engine delivery boundary separately.

Reproduce: `npm run test:ui:dashboard`. Before capture:
`NEST_DASHBOARD_BEFORE=1 npm run test:ui:dashboard` (requires the baseline Git object).
Capture outputs go to a temporary directory printed by the script, never private
runtime files. `npm run test:ui:projects` includes this scenario in existing CI.
