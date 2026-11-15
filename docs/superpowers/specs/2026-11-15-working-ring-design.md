# Working ring: what the agent is doing, on hover

Date: 2026-11-15. Status: draft for approval. Size: small change (short design).

## Intent

While an agent works, the chat shows only "NikiPA · Working…". The owner wants to
see what the agent is doing right now (is it making progress or stuck, which app
is it touching) without opening anything, in the spirit of lot-map: a ring of
"stations" around the agent where each action sends a pulse to its station.
The lines and Details under finished replies stay exactly as they are.

## Goals

- Hovering (or keyboard-focusing) the working row opens a small card with:
  - the agent's avatar in the middle and a ring of stations it has used this turn
    (Shell, Files, Memory, Messages, Agents, one per connected app with its logo);
  - a pulse from the centre to a station on every action, a count per station;
  - a breathing ring around the avatar while the model is thinking between actions;
  - a red station and a ✗ entry when an action fails;
  - the last five actions by name ("Miro · Create card", "Shell · ran a command")
    with how long ago, and a header with elapsed time and action count.
- The card is live: it updates as events arrive and closes when the turn ends.

## Non-goals

- Mobile/touch. Desktop hover and keyboard focus only; touch is decided later.
- Any change to lines, failures or Details under replies.
- A history or replay of past turns.

## Anti-goals

- Commands, arguments, file paths, provider results or process output in the card.
  Action names only (chat anti-goal 6: activity details are never quoted, copied or
  exported).
- Motion for people who asked their system for reduced motion: they get the lit
  stations and list, no pulses or breathing.
- The card covering the composer or jumping around while it is open.

## Approaches

1. **Ring of stations (chosen by the owner).** Closest to lot-map; most layout work.
2. Station chips with a live feed. Same information as a row of chips; easier,
   loses the map feel.
3. Feed only. Dropped: mostly what Details already shows.

Mockup: `.superpowers/brainstorm/3955150-1794732344/content/working-ring-v2.html` (local, not committed) (prototype; behaviour is
what ships, the look follows Nest's tokens, icons, logos and avatars).

## Design

**Data.** The card reads the events of the agent's open turn in this chat, the
same events the timeline already groups for that turn (history and live). No
engine change.

- `tool.started` / `tool.executed` / `tool.failed`: station by tool family (shell
  tools → Shell, file tools and uploads → Files, memory tools → Memory,
  `events_emit` and messaging → Messages, agent tools → Agents). Exact mapping and
  verbs come from the engine's tool names.
- `process.started` → Shell (one action per process); a non-zero exit marks it
  failed, using the same success/failure rule the Details boxes use.
- `telemetry.nest.connection.action` → the app's station with the action title.
- Thinking: no tool in flight since the last finished action (and
  `agent.turn.phase` events) → the avatar ring breathes.

**App reads (new, small API change).** Today Nest records only app changes. The
execute route also records reads, so the card can show "Miro · Get board":

- same event type `telemetry.nest.connection.action`, `change` gains `read`
  (`readOnlyHint`) and `other` (no hint tags); same channel checks, same
  best-effort posting, same payload rules (no arguments or results);
- `skills/nest-connections/event-shapes.ts` accepts the new values; `skill.json`
  version bump;
- the lines under replies keep showing only `create` / `update` / `delete`;
  reads and `other` appear in the card and in Details only.

**UI.** `WorkingRow` gets the turn's events and wraps its row in a hover card
(radix `HoverCard` from the existing `radix-ui` package; opens on hover and focus,
closes on Escape and when the turn ends). The ring is an SVG: stations on an
ellipse in first-use order, `IntegrationLogo` for apps, lucide icons for the rest,
`AgentAvatar` in the centre. Pulses use the existing `motion` library and respect
`useReducedMotion`. Colours come from Nest tokens in light and dark mode.

## Left to the builder

- Station placement beyond eight stations (e.g. least-used merge into "Other").
- Verbs per tool family; card size and offset so it never covers the composer.
- How the elapsed timer ticks without re-rendering the whole thread.

## Calls I made (correct any of these)

- Record app reads (and untagged tools) as events so the card can name them;
  they never become lines under replies.
- Process exits count as Shell actions, coloured with the existing Details rule.
- Keyboard focus opens the card too, so it is not mouse-only.
- Mobile shows nothing new until we decide how touch should open it.

## Follow-up: state line and merged repeats (approved 2026-11-15)

The header names what the agent is doing now instead of "is working": "is
thinking…" (no tool running; the engine reports no separate reasoning events),
"is waiting on a command · 40s" (a shell tool running, timed from its start),
"is using Fathom" (that command has called a connected app), otherwise "is
working". Identical actions in a row share one feed line with a count ("Fathom ·
List Meetings ×30"), so a loop is visible at a glance. No new sections: context
use, step counts and output stay in Details.
