import { z } from 'zod';

export const MAX_NOTES_CHARS = 20_000;
export const MAX_CONTEXT_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_CONTEXT_FILES_PER_SCOPE = 50;
export const MAX_CONTEXT_BYTES_PER_CANVAS = 200 * 1024 * 1024;
export const MAX_LINKS_PER_AREA = 10;

export type ContextScope = { kind: 'canvas'; canvasId: string } | { kind: 'area'; canvasId: string; areaId: string };

export const ContextNotesSchema = z.object({ notes: z.string().max(MAX_NOTES_CHARS), version: z.number().int().min(0) }).strict();
export const ContextLinkSchema = z.object({ sourceAreaId: z.string().uuid() }).strict();
export const UseHomeSchema = z.object({ channelId: z.string().min(1).max(200) }).strict();

export type ContextFile = { id: string; name: string; mime: string; size: number; uploadedBy: string; uploadedAt: number };
export type ContextLink = { sourceAreaId: string; title: string; canvasName: string | null; available: boolean };
export type ScopeContext = {
  notes: string; version: number; files: ContextFile[]; links: ContextLink[];
  usedBy: { areaId: string; title: string | null }[];
};
export type ChatHome = { canvasId: string; areaId: string | null };
/** One board load's context markers: which scopes hold notes or files, and each area's links (for its `↳` chips). */
export type ContextSummary = {
  areas: { areaId: string; hasContext: boolean; links: { sourceAreaId: string; title: string; available: boolean }[] }[];
  canvas: { hasContext: boolean };
};
/** An agent in a chat homed in an area, and whether it can read context there. */
export type ContextReader = { agentName: string; state: 'ready' | 'wrapped' | 'unconfigured' };

/** The new home after a card move, or null when the home stays as it is. */
export function homeAfterMove(current: ChatHome | null, move: { canvasId: string; areaId: string | null; byMember: boolean }): ChatHome | null {
  if (!move.byMember) return null;
  if (!current) return { canvasId: move.canvasId, areaId: move.areaId };
  if (current.canvasId !== move.canvasId) return null;
  return { canvasId: move.canvasId, areaId: move.areaId };
}
