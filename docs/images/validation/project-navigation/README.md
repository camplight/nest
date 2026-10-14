# Project navigation validation

Screenshots use disposable synthetic fixtures and default Nest branding.
`before-desktop.png` shows the prior disconnected sidebar from PR35's first
implementation. Final desktop/mobile/dashboard images show the Projects group
with ten fixture projects, a five-project shortcut limit, View all projects and
New project nested under Projects. The active older project is retained in the
desktop list. Mobile capture waits for the existing drawer transition to finish.

Capture with `node --import tsx tests/browser/projects.ts`. This uses real
Nest/OrgOps HTTP handlers and disposable databases; it invokes no runner/model.
No production tenant data or credentials are included.
