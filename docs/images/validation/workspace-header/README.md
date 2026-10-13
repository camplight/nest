# Figma workspace header validation

Captured 2026-10-13 after checks passed. All accounts, projects, tasks and mention
messages are synthetic test data. No production tenant data or credentials appear.
The icons are original Figma exports, not a screenshot used as the application UI.

- `header-desktop.png`, `header-mobile.png`: centered/per-view search, theme,
  notifications, settings and account icons; Skills in the sidebar.
- `header-account-desktop.png`, `header-account-mobile.png`: authenticated identity,
  keyboard account menu, agent/settings shortcuts and real session logout.
- `header-settings-desktop.png`, `header-settings-mobile.png`: independent appearance
  controls and owner-gated administration, checked through the actual engine.
- `header-notifications-desktop.png`, `header-notifications-mobile.png`: real selected
  human mention, owner-visible project label and persistent read-state navigation.
- `header-dark-desktop.png`: synchronized dark theme and original icon geometry.

Verification: 86 product tests; full lint; both builds; project/dashboard, community,
agent/model/fuzzy and targeted mentions, Google auth and personal onboarding browser
suites. Onboarding was also validated on alternate port 5314 to avoid an existing
local listener; its scenario was otherwise unchanged. CI runs the ordinary script.

The dashboard browser scenario uses real Nest/OrgOps handlers. It invites a second
human, completes that account's required password setup, grants chat membership,
sends a selected mention and verifies read state and exact project/message links.
It also checks nonowner administration denial, metadata outage/retry, independent
theme changes, keyboard focus restoration, category URLs/reload, project search,
logout and original header SVG rendered dimensions. No LLM/provider calls occur.

Reproduce with `npm run test:ui:dashboard`. The existing projects CI step includes
this scenario. Before comparison is the merged PR #23 capture under
`../dashboard/dashboard-desktop.png` (same synthetic project fixture).
