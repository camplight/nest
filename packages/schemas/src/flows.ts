import { z } from 'zod';

export const LinkWhat = z.enum(['results', 'summary', 'all']);
export type LinkWhat = z.infer<typeof LinkWhat>;
export const LinkWhen = z.enum(['done', 'approve', 'manual']);
export type LinkWhen = z.infer<typeof LinkWhen>;
export const LinkKind = z.enum(['link', 'fork']);
export type LinkKind = z.infer<typeof LinkKind>;
export const PausedReason = z.enum(['cap', 'access', 'agent-left', 'unavailable']).nullable();
export type PausedReason = z.infer<typeof PausedReason>;

export const LINK_HOURLY_CAP = 20;
export const MAX_LINK_LABEL = 60;
export const MAX_LINKS_PER_CHAT = 50;

const channelId = z.string().min(1).max(200);
const label = z.string().trim().min(1).max(MAX_LINK_LABEL);
const who = z.string().min(1).max(200).nullable();
const version = z.number().int().min(0);

export const NewLinkSchema = z.object({
  id: z.string().uuid(),
  from: channelId,
  to: channelId,
  what: LinkWhat.optional().default('results'),
  when: LinkWhen.optional().default('done'),
  who: who.optional(),
  label: label.optional().default('results'),
  intro: z.boolean().optional(),
}).strict().refine(v => v.from !== v.to, { message: 'A chat cannot link to itself', path: ['to'] });
export type NewLink = z.infer<typeof NewLinkSchema>;

export const LinkPatchSchema = z.object({
  what: LinkWhat.optional(),
  when: LinkWhen.optional(),
  who: who.optional(),
  label: label.optional(),
  on: z.boolean().optional(),
  version,
}).strict();
export type LinkPatch = z.infer<typeof LinkPatchSchema>;

export type Link = {
  id: string; kind: LinkKind; from: string; to: string;
  what: LinkWhat; when: LinkWhen; who: string | null; label: string;
  on: boolean; pausedReason: PausedReason;
  createdBy: string; createdAt: number; version: number;
};

/** canManage: pause or disconnect (creator or a target member). canEdit: change what/when/who/label (creator only; implies canManage). */
export type BoardLink = { id: string; kind: LinkKind; from: string; to: string; on: boolean } & (
  | { access: 'open'; label: string; what: LinkWhat; when: LinkWhen; who: string | null; pausedReason: PausedReason; canManage: boolean; canEdit: boolean }
  | { access: 'locked' }
);

/** Edge text as the mock's labelFor, plus the paused suffix. Fork links ignore `when`. */
export function linkLabel(l: { label: string; when: LinkWhen; on: boolean; kind: LinkKind }): string {
  const gate = l.kind === 'fork' ? '' : l.when === 'approve' ? ' · needs OK' : l.when === 'manual' ? ' · manual' : '';
  return `${l.label}${gate}${l.on ? '' : ' · paused'}`;
}

export type FlowNeed = {
  key: string; kind: 'approval' | 'paused' | 'missed'; channelId: string; at: number; from: string | null;
  short: string; reason: string; detail: string;
  gate:
    | { kind: 'approval'; deliveryId: string; linkId: string } | { kind: 'paused'; linkId: string }
    | { kind: 'missed'; scheduleId: string; runId: string }
    /** A schedule Nest paused (kind 'paused'); resumed with PATCH /api/flows/schedules/:id {on:true}. No buttons yet. */
    | { kind: 'schedule-paused'; scheduleId: string };
};

/** The findings link a fork gets, stored child → parent and drawn parent → child. */
export const FORK_LINK_LABEL = 'fork · findings flow back';
/** How much of the forked message the seed quotes. */
export const FORK_QUOTE_CHARS = 2_000;
/** How many messages, ending at the forked one, the seed summarises. */
export const FORK_SUMMARY_MESSAGES = 40;

/**
 * Forks a chat from one message into a chat the viewer started. `timeZone` (IANA) is the viewer's, for the seed's
 * `{HH:MM}`; without it the time is UTC.
 */
export const NewForkSchema = z.object({
  childChannelId: channelId,
  parentChannelId: channelId,
  parentEventId: z.string().min(1).max(200),
  timeZone: z.string().min(1).max(64).optional(),
}).strict().refine(v => v.childChannelId !== v.parentChannelId, { message: 'A chat cannot be a fork of itself', path: ['childChannelId'] });
export type NewFork = z.infer<typeof NewForkSchema>;
/** A fork of a chat as GET /api/flows/forks lists it; `title` is 'a private chat' when the viewer cannot read the fork. */
export type ForkView = { childChannelId: string; parentEventId: string; title: string };

/** The mock's fork title: `Fork: ` and the message's first sentence, up to 38 characters. */
export function forkTitle(text: string): string {
  const first = (text.split(/[.:?!]/)[0] ?? '').replace(/\s+/g, ' ').trim().slice(0, 38).trimEnd();
  return first ? `Fork: ${first}` : 'Fork';
}
