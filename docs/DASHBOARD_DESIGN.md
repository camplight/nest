# Home dashboard design baseline

Reference: [Camplight dashboard, Figma 923:417](https://www.figma.com/design/Rqfq3v9a8nZfQKbM3Q0NZk/Portfolio---Case-Studies?node-id=923-417).
Design context was read on 2026-10-13. The reference is an editable frame, not a
screenshot embedded in the application. Production was inspected read-only at
image `nest:git-192dd85a8fca`; an empty account hid the metric/project/activity
areas and community entirely. Private production content is excluded from PRs.

## Acceptance

- The shell keeps instance branding above navigation and Powered by Nest below.
- At 1440px, the 248px sidebar leaves a 1192px workspace; its 32px content insets
  produce three 360px metric cards with 24px gaps and two 552px work columns.
- Header height is 74px. Section spacing is 32px. Cards use 8px corners, a light
  border, Unbounded titles and Inter content. Original Figma artwork stays local.
- Shared top bars on Dashboard, Projects, Agents and Community use Figma's
  search, MoonStars, BellRinging, GearSix and User controls. On mobile the icons
  remain visible above a full-width search field. Each search filters its view.
- The bell opens actual selected-mention notifications and marks them read only
  when visited. Settings offers browser appearance, agent configuration and an
  owner-only administration link. Account shows the signed-in user and sign-out.
- Skills navigation opens `?view=community&category=skill`, retaining its filter
  and selected navigation through reload/history. The catalog is the existing
  tenant library, not another copy of the engine's enabled-skill configuration.
- Spend, Tasks and Issues remain visible for empty accounts. Unavailable values
  are dashes with an explanation, never zero money or a fake incident count.
- Finished means human-approved tasks. Need review means submitted deliverables
  awaiting a human decision. Progress is the approved fraction of all tasks.
- Active projects include unfinished work and projects without tasks. Finished
  projects remain reachable through All projects. Agent counts are task assignees.
- Up next prioritizes pending reviews, then session-local unread chats. Review
  opens the exact project/task URL. All expands the same activity items.
- Changes requested remain separate from operational incidents. Urgent issues
  does not claim monitoring is healthy or that there are zero alerts.
- Community previews the eight latest packages from the existing private catalog,
  featuring its most recent automation when present. Every tile opens real detail.
- Desktop, mobile (390px), dark mode, keyboard carousel navigation, asset loading,
  empty state, outage/retry, history/reload and changed engine access are verified.
  Both the document and dashboard must fit the mobile viewport; only the community
  strip intentionally scrolls horizontally. Obsolete fetches are cancelled.

## Deliberate differences and remaining work

| Figma example | Product behavior / remaining work |
| --- | --- |
| Spend values and trend percentages | Unavailable until provider billing/usage is tracked. Subscription runtimes must not be assigned fictional costs. |
| Finished/review issue counts and critical rate-limit alerts | Unavailable until an operational issue source and severity/lifecycle model are defined. Task revision requests are not incidents. |
| On Track, hours, project spend | Real task-state labels, approved progress, assignee and task counts. No schedule confidence, runtime duration or cost estimates. |
| Dismiss review | Omitted: pending deliverables remain pending until an explicit review in Projects. |
| Manage layout and celebration badge | Working Refresh; layout preferences and celebration counts remain deferred. Original theme/notification/settings/account controls are now implemented. |
| Notification center | The bell uses existing persistent human mentions. Task review cards remain in Up next; general task, system and email notifications are not implemented. |
| Community discussion/replies, runs, team installations, example contributors | Existing automation/agent-skill/use-case packages, version and actual publisher/date. Artwork slots reuse the original automation, discussion and application assets; categories reflect Nest's catalog. |
| Fixed desktop canvas and clipped community art tiles | Responsive stacked work/metric cards and horizontally scrollable package cards. Secondary tiles show their real package title for discoverability. |
| Flat unavailable sections | Honest empty/unavailable cards, with no fabricated carousel dots or counts. |

## Asset ownership

Original exports are under `apps/user-ui/public/design/dashboard`:
`automation.png` (923:653), `skill-background.png` (923:675), `skill.png`
(923:676), `use-case.png` (923:683), `progress.svg` (923:572), and
`arrow-right.svg` (923:578). Existing search/sidebar icons, instance logo and
agent portraits are reused. Project icon SVG root dimensions remain 24 × 24. The featured
art slot clips the 408 × 230 automation image inside 250 × 230, matching Figma;
the skill tile composes its original background and 212 × 212 foreground.

Header assets `theme.svg`, `notifications.svg`, `settings.svg` and `account.svg`
are the original nodes 923:469, 923:471, 923:473 and 923:475. Their root/rendered
sizes are respectively 42 × 41, 40 × 42, 42 × 40 and 41 × 40 inside 44px buttons.
The Skills icon (`design/skills.svg`, 923:441) remains 24 × 24. Browser checks
verify these effective sizes without editing SVG root dimensions.

No OrgOps files, engine schemas, runner behavior, credentials or migration are
changed. The summary is a Nest product API using the existing project permission
boundary; details are in [SPEC.md](SPEC.md).
