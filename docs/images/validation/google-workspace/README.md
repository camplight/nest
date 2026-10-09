# Google Workspace sign-in validation

Captured from the implemented Nest UI on 2026-10-09 by `npm run test:ui:auth`,
after typechecks, production builds and product tests passed. Desktop: 1440×1100;
mobile: 390×844 (full-page capture). These are local implementation screenshots,
not Figma mockups or production tenant data.

The local harness uses isolated Nest and OrgOps databases, `example.com`, an
`Example team`, and a fixture owner. Google token exchange/verification and its
external redirect are simulated; engine state cookies, callbacks, sessions,
automatic accounts and authorization are real. The visible localhost callback is
for this test only. Production requires its own HTTPS callback and OAuth client.

- `google-settings-desktop.png` / `google-settings-mobile.png`: owner settings.
- `google-login-desktop.png` / `google-login-mobile.png`: colleague login.
- `google-admin-login-desktop.png` / `google-admin-login-mobile.png`: admin login.

No OAuth credentials, tenant data or live account sessions appear in these images.
