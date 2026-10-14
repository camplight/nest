# Project creation validation screenshots

All images use isolated, synthetic test data and the default Nest branding.
They contain no live tenant content, provider credentials or production accounts.

- `before-desktop.png`, `before-mobile.png`: the previous project creation form at
  main `8c70642b65616c7d40f255fb0b70771abe108f7c`.
- `project-create-simple-desktop.png`, `project-create-simple-mobile.png`: the final
  name-only flow. Create project fits the initial 390 × 844 mobile viewport.
- `project-create-team-desktop.png`, `project-create-team-mobile.png`: optional
  description and expanded team selection. The expanded mobile form scrolls.
- `project-create-selected-mobile.png`: the collapsed picker with selected members;
  this longer mobile form scrolls to its footer.
- `project-chat.png`, `project-chat-mobile.png`: Chat/Files/Members navigation and
  project-name composer. The desktop About panel shows live channel participants.

Captured with `node --import tsx tests/browser/projects.ts` after product tests,
lint/build and desktop/mobile interaction checks. API requests use real Nest and
OrgOps handlers with disposable databases; no runner/model is invoked.

The design reference is Figma file `Rqfq3v9a8nZfQKbM3Q0NZk`, project workspace
`849:599` ([existing reference](../../nest-projects-figma.png)). It is a flattened
workspace image, not a creation-dialog specification. The form extends Nest's
existing tokens and components; the original agent portraits are reused.
