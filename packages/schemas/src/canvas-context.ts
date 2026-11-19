import { z } from 'zod';

export const MAX_NOTES_CHARS = 20_000;
export const MAX_CONTEXT_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_CONTEXT_FILES_PER_SCOPE = 50;
export const MAX_CONTEXT_BYTES_PER_CANVAS = 200 * 1024 * 1024;
export const MAX_LINKS_PER_AREA = 10;
export const MAX_WEB_LINKS_PER_SCOPE = 50;
export const MAX_WEB_LINK_URL = 2048;
export const MAX_WEB_LINK_TITLE = 200;

export type ContextScope = { kind: 'canvas'; canvasId: string } | { kind: 'area'; canvasId: string; areaId: string };

export const ContextNotesSchema = z.object({ notes: z.string().max(MAX_NOTES_CHARS), version: z.number().int().min(0) }).strict();
export const ContextLinkSchema = z.object({ sourceAreaId: z.string().uuid() }).strict();
/** The normalized http(s) form of a pasted URL, or null when it is not a web URL or is too long. */
export function normalizeWebUrl(input: string): string | null {
  if (input.length > MAX_WEB_LINK_URL) return null;
  let url: URL;
  try { url = new URL(input); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.href.length > MAX_WEB_LINK_URL ? null : url.href;
}
export const ContextWebLinkSchema = z.object({
  url: z.string().max(MAX_WEB_LINK_URL).refine(u => normalizeWebUrl(u) !== null, 'Enter an http or https URL'),
  title: z.string().trim().max(MAX_WEB_LINK_TITLE).optional(),
}).strict();
export const UseHomeSchema = z.object({ channelId: z.string().min(1).max(200) }).strict();

/** A pasted web address kept in a scope's context. */
export type ContextWebLink = { id: string; url: string; title: string | null; addedBy: string; addedAt: number };
export type ContextFile = { id: string; name: string; mime: string; size: number; uploadedBy: string; uploadedAt: number };
/** Whether a scope has notes and how many files it holds: what an area's `◱ Notes · 2 files` chip reads. */
export type ContextCounts = { notes: boolean; fileCount: number };
/** The most files the board summary lists per area, for the file shelf on an area with no chats. */
export const SUMMARY_SHELF_FILES = 8;
/**
 * A link to another area's context. `canvasId`/`canvasName` name the source canvas and `counts` its notes and files,
 * only for viewers who can read that canvas (null otherwise); `counts` is also null while the link is unavailable.
 */
export type ContextLink = {
  sourceAreaId: string; title: string; canvasId: string | null; canvasName: string | null; available: boolean; counts: ContextCounts | null;
};
/** An area that uses this one's context. Its title is null when the viewer cannot read its canvas. */
export type ContextUse = { areaId: string; title: string | null };
export type ScopeContext = {
  notes: string; version: number; files: ContextFile[]; webLinks: ContextWebLink[]; links: ContextLink[];
  usedBy: ContextUse[];
  /** Whether any chat's (available) home context includes this scope, including chats homed in areas that link here. */
  inChats: boolean;
};
export type ChatHome = { canvasId: string; areaId: string | null };
/** A file on an area's shelf: enough for a tile and its download link. */
export type ContextShelfFile = { id: string; name: string; mime: string };
/**
 * One board load's context markers: each scope's notes flag and file count (the chips), an area's first
 * SUMMARY_SHELF_FILES files (the shelf), its links with their own counts (the `↳` chips) and the areas that
 * use it (the "Used by …" footer). `hasContext` is notes or files.
 */
export type ContextSummary = {
  areas: ({ areaId: string; hasContext: boolean; files: ContextShelfFile[]; links: ContextLink[]; usedBy: ContextUse[] } & ContextCounts)[];
  canvas: { hasContext: boolean } & ContextCounts;
};
/** An area another person could link: one row of the "Use context from another area" picker. */
export type ContextSource = { canvasId: string; canvasName: string; areaId: string; title: string; counts: ContextCounts };
/** An agent in a chat homed in an area, and whether it can read context there. */
export type ContextReader = { agentName: string; state: 'ready' | 'wrapped' | 'unconfigured' };

/**
 * The new home after a card placement or move, or null when the home stays as it is. Only a member's
 * placement (`placement: true`) can give a homeless chat its first home; a move never creates one (R19).
 */
export function homeAfterMove(
  current: ChatHome | null, move: { canvasId: string; areaId: string | null; byMember: boolean; placement: boolean },
): ChatHome | null {
  if (!move.byMember) return null;
  if (!current) return move.placement ? { canvasId: move.canvasId, areaId: move.areaId } : null;
  if (current.canvasId !== move.canvasId) return null;
  return { canvasId: move.canvasId, areaId: move.areaId };
}
