# Room agent runtime indicators

Captured on 2026-10-21 from the final implementation using isolated synthetic
rooms, people and agents. Runtime states are controlled through the real engine
HTTP API; no live runner, model or external account is used. These are Nest's
existing room layouts and original Figma character assets, not new Figma exports
or production screenshots.

- `project-desktop.png`: project details show running, stopped, starting and
  crashed/error agents, with no inferred status on the human participant.
- `project-mobile.png`: expanded project details retain dots and visible labels.
- `standalone-desktop.png`: the same component in the standalone room roster.
- `members-mobile.png`: mobile participant management, opened after closing
  channel settings so the member dialog is visible.

Validation passed: 166 product tests; user UI type checks/build;
`npm run test:ui:agents` (including the new real-engine status flow); and
`npm run test:ui:projects` (projects, dashboard and chat).

The status flow covers start/stop transitions, ten-second refresh without
WebSockets, focus refresh, lookup failure/unknown, recovery, reload and mobile
layout. `Running` is reported engine runtime state, not a provider/runner health
probe or an indication that the agent is currently working on a task.
