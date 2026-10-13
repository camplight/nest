# Connected-app action picker validation

Captured from the final implementation by `npm run test:ui:onboarding` on
2026-10-13 after lint, build and onboarding checks passed. The fixture uses
synthetic Camplight branding, an owner named Vitaliy and PuffVitaliy; no production
accounts, tenant content, credentials or external tool calls appear here.

The browser scenario runs the real Nest API and untouched OrgOps engine. Composio
catalog/account responses are test fixtures. A deliberate failed save is injected
before the real grant handler; retry is checked against actual saved permissions.

- `actions-unsaved-desktop.png`: two pending choices; no access granted yet.
- `actions-saved-desktop.png`: one saved action after retrying a failed save.
- `actions-selected-desktop.png`: Selected view retains choices across search
  and provider pagination.
- `actions-unsaved-mobile.png`: responsive action cards at 390 px.
- `actions-saved-mobile-footer.png`: separate scrolled mobile view showing the
  saved status and controls beneath the bounded action list.
- `actions-dark-desktop.png`: dark theme, with transitions settled for capture.

These images show different UI states in the same implementation; they are not
before/after revisions. Exact provider action IDs remain under About this action,
and grants still use the existing API. The suite also checks discard/clear,
no-match search, failed save retention, exact saved IDs, explicit activation,
renewal and private-context lifecycle checks.
