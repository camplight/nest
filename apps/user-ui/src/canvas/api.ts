// Typed helpers for the product /api/canvases routes (apps/api/src/canvases.ts).
import type {AreaPatch,Canvas,CanvasArea,CanvasBoard,CanvasCardRow,CanvasRole,CanvasVisibility,NewArea} from '@nest/schemas';
import {ApiError,apiFetch,apiJson,getApiHeaders} from '../api';

/** A versioned write lost a race: `current` is the stored row (or null when it was deleted). */
export class CanvasConflict extends Error {
  constructor(readonly current: unknown) {
    super('Canvas changed');
    this.name = 'CanvasConflict';
  }
}
/** 404: the canvas is missing or the caller has no access; the API does not distinguish them. */
export const isCanvasGone = (error: unknown) => error instanceof ApiError && error.status === 404;
export const isCanvasForbidden = (error: unknown) => error instanceof ApiError && error.status === 403;

/**
 * Runs a canvas-level write (rename, sharing, delete) with the canvas version. Another editor's layout write
 * bumps that version, so a 409 re-reads the current version and tries once more; a second conflict is the caller's.
 */
export async function withFreshVersion<T>(version: number, fresh: () => Promise<number | null>, run: (version: number) => Promise<T>): Promise<T> {
  try {
    return await run(version);
  } catch (error) {
    if (!(error instanceof CanvasConflict)) throw error;
    const next = await fresh();
    if (next === null) throw error;
    return run(next);
  }
}

export type CanvasMember = {humanId: string; username: string; role: CanvasRole};
export type CanvasMembers = {visibility: CanvasVisibility; members: CanvasMember[]};
export type CanvasSharingInput = {visibility: CanvasVisibility; members: {humanId: string; role: 'edit' | 'view'}[]; version: number};
export type CardPlacement = {channelId: string; x: number; y: number; w?: number};
export type BoardResponse = CanvasBoard | {unchanged: true};
export type AreaPatchResult = {area: CanvasArea; cards: CanvasCardRow[]; areas: CanvasArea[]};

function translate(error: unknown): unknown {
  if (!(error instanceof ApiError) || error.status !== 409) return error;
  try {
    const body = JSON.parse(error.message) as {error?: string; current?: unknown};
    if (body.error === 'Canvas changed') return new CanvasConflict(body.current ?? null);
  } catch {}
  return error;
}
async function json<T>(path: string, init?: RequestInit): Promise<T> {
  try { return await apiJson<T>(path, init); } catch (error) { throw translate(error); }
}
async function send(path: string, init: RequestInit): Promise<void> {
  try { await apiFetch(path, init); } catch (error) { throw translate(error); }
}
const write = (method: string, body: unknown): RequestInit => ({method, headers: getApiHeaders(), body: JSON.stringify(body)});
const canvasPath = (id: string) => `/api/canvases/${encodeURIComponent(id)}`;

export const canvasAvailability = () => json<{available: boolean}>('/api/canvases/availability');
export const listCanvases = () => json<Canvas[]>('/api/canvases');
/** The id is chosen here, so a retried create is idempotent. */
export const createCanvas = (name: string, id: string = crypto.randomUUID()) => json<Canvas>('/api/canvases', write('POST', {id, name}));
export const renameCanvas = (id: string, name: string, version: number) => json<Canvas>(canvasPath(id), write('PATCH', {name, version}));
export const deleteCanvas = (id: string, version: number) => send(`${canvasPath(id)}?version=${version}`, {method: 'DELETE'});

export const getMembers = (id: string) => json<CanvasMembers>(`${canvasPath(id)}/members`);
export const putMembers = (id: string, sharing: CanvasSharingInput) => json<CanvasMembers>(`${canvasPath(id)}/members`, write('PUT', sharing));

/** With the last board's etag, an unchanged board answers `{unchanged:true}`. */
export const getBoard = (id: string, etag?: string) =>
  json<BoardResponse>(`${canvasPath(id)}/board${etag ? `?etag=${encodeURIComponent(etag)}` : ''}`);

export const createArea = (id: string, area: NewArea) => json<CanvasArea>(`${canvasPath(id)}/areas`, write('POST', area));
export const patchArea = (id: string, areaId: string, patch: AreaPatch, moveCards = false) =>
  json<AreaPatchResult>(`${canvasPath(id)}/areas/${encodeURIComponent(areaId)}${moveCards ? '?moveCards=1' : ''}`, write('PATCH', patch));
export const deleteArea = (id: string, areaId: string, version: number) =>
  send(`${canvasPath(id)}/areas/${encodeURIComponent(areaId)}?version=${version}`, {method: 'DELETE'});

export const placeCards = (id: string, cards: CardPlacement[], area?: NewArea) =>
  json<CanvasBoard>(`${canvasPath(id)}/cards`, write('POST', area ? {cards, area} : {cards}));
export const moveCard = (id: string, channelId: string, patch: {x: number; y: number; w?: number; version: number}) =>
  json<CanvasCardRow>(`${canvasPath(id)}/cards/${encodeURIComponent(channelId)}`, write('PATCH', patch));
export const removeCard = (id: string, channelId: string, version: number) =>
  send(`${canvasPath(id)}/cards/${encodeURIComponent(channelId)}?version=${version}`, {method: 'DELETE'});

export const getHidden = () => json<{channelIds: string[]}>('/api/canvases/hidden');
export const setHidden = (channelIds: string[], hidden: boolean) => json<{channelIds: string[]}>('/api/canvases/hidden', write('POST', {channelIds, hidden}));

/** The board writes the board store sends; injected so the store stays testable. */
export const boardApi = {getBoard, moveCard, removeCard, placeCards, createArea, patchArea, deleteArea};
