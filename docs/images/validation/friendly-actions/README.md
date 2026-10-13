# Connected-app access validation

Captured from the final implementation by `npm run test:ui:onboarding` on
2026-10-13 after lint/build checks passed. The fixture uses synthetic Camplight
branding, an owner named Vitaliy and PuffVitaliy. No production accounts, tenant
content, credentials or external tool executions appear here.

The browser runs the real Nest API and untouched OrgOps. Composio catalog/account
responses are fixtures. Deliberate failed page/save responses verify no partial
selection or grant, with successful retry checked against actual permissions.
A 101-action fixture checks the existing limit. The default view is checked for
hidden granular controls, no catalog requests, and a compact card (under 260 px
on desktop / 360 px on mobile for this fixture). Brand images are checked to load
locally; an unknown app exercises the generic icon fallback.

- `connections-compact-desktop.png`, `connections-compact-mobile.png`: default
  Give all access action, collapsed advanced options and compact catalog logos.
- `connections-all-given-desktop.png`, `connections-all-given-mobile.png`: all
  four exact provider actions saved in one click, advanced options still hidden.
- `connections-compact-dark.png`: default dark layout with one saved action.
- `actions-unsaved-desktop.png`, `actions-unsaved-mobile.png`: advanced pending
  choices, compact action rows and explicit Save access.
- `actions-saved-desktop.png`, `actions-saved-mobile-footer.png`: one saved action
  after retry; the mobile image is a scrolled view of the controls.
- `actions-selected-desktop.png`: selected choices retained across search/pages.
- `actions-all-desktop.png`, `actions-all-mobile.png`,
  `actions-all-mobile-footer.png`: advanced Select all stages choices; mobile
  footer is a separate scrolled view. This flow still requires Save access.
- `actions-dark-desktop.png`: advanced options in the dark theme.

These images show different states of the same final implementation; they are
not before/after revisions. Give all ignores an advanced search and persists the
whole current catalog. Advanced search/bulk selection keeps prior choices.
Activation, renewal, next-message readiness and privacy lifecycle checks also
pass. Give all grants a snapshot of current tools; it does not grant future tools
or automatically activate the agent's connection capability.
