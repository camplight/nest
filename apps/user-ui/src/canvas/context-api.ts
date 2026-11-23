// Typed helpers for the canvas context routes (apps/api/src/canvas-context.ts): notes, files, links and readers.
import type {ContextFile,ContextWebLink,ContextReader,ContextSource,ContextSummary,ScopeContext} from '@nest/schemas';
import {ApiError,apiFetch,apiJson,getApiHeaders} from '../api';
import {apiUrl} from '../config';
import {NotesConflict} from './notes-autosave';

/** The canvas itself, or one of its areas. */
export type PanelScope = {kind: 'canvas'} | {kind: 'area'; areaId: string};
export type {ContextSource};

const canvasPath = (canvasId: string) => `/api/canvases/${encodeURIComponent(canvasId)}`;
export const scopePath = (canvasId: string, scope: PanelScope) =>
  `${canvasPath(canvasId)}${scope.kind === 'area' ? `/areas/${encodeURIComponent(scope.areaId)}` : ''}/context`;
const write = (method: string, body: unknown): RequestInit => ({method, headers: getApiHeaders(), body: JSON.stringify(body)});

/** The error text the API sent ({error}), or the raw message. */
export function errorText(error: unknown, fallback: string) {
  if (!(error instanceof Error)) return fallback;
  try { return (JSON.parse(error.message) as {error?: string}).error || fallback; } catch { return error.message || fallback; }
}

export const getContextSummary = (canvasId: string) => apiJson<ContextSummary>(`${canvasPath(canvasId)}/context/summary`);
export const getContext = (canvasId: string, scope: PanelScope) => apiJson<ScopeContext>(scopePath(canvasId, scope));

export async function putNotes(canvasId: string, scope: PanelScope, notes: string, version: number) {
  try {
    return await apiJson<ScopeContext>(scopePath(canvasId, scope), write('PUT', {notes, version}));
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      const body = (() => { try { return JSON.parse(error.message) as {current?: ScopeContext}; } catch { return {}; } })();
      if (body.current) throw new NotesConflict(body.current);
    }
    throw error;
  }
}

/** A notes save sent as the page goes away: keepalive lets it finish after unload. Best effort, nothing to report. */
export function putNotesKeepalive(canvasId: string, scope: PanelScope, notes: string, version: number) {
  try {
    void fetch(apiUrl(scopePath(canvasId, scope)), {method: 'PUT', keepalive: true, credentials: 'include', headers: getApiHeaders(), body: JSON.stringify({notes, version})}).catch(() => {});
  } catch { /* A body over the keepalive limit (64 KB) throws; the unmount save may still reach it. */ }
}

/** One file per request, through XMLHttpRequest for upload progress; a non-2xx answer rejects with its text. */
export function uploadContextFile(canvasId: string, scope: PanelScope, file: File, onProgress: (fraction: number) => void) {
  return new Promise<ContextFile>((resolve, reject) => {
    const body = new FormData();
    body.append('file', file, file.name);
    const request = new XMLHttpRequest();
    request.open('POST', apiUrl(`${scopePath(canvasId, scope)}/files`));
    request.withCredentials = true;
    request.upload.onprogress = event => { if (event.lengthComputable && event.total > 0) onProgress(Math.min(1, event.loaded / event.total)); };
    request.onload = () => {
      if (request.status < 200 || request.status >= 300) { reject(new Error(request.responseText || `Request failed: ${request.status}`)); return; }
      try { resolve((JSON.parse(request.responseText) as ContextFile[])[0]); } catch (reason) { reject(reason); }
    };
    request.onerror = request.onabort = () => reject(new TypeError('Failed to fetch'));
    request.send(body);
  });
}
export const deleteContextFile = (canvasId: string, scope: PanelScope, fileId: string) =>
  apiFetch(`${scopePath(canvasId, scope)}/files/${encodeURIComponent(fileId)}`, {method: 'DELETE'}).then(() => undefined);
/** Downloads go through the canvas path whatever the file's scope. */
export const contextFileHref = (canvasId: string, fileId: string) => apiUrl(`${canvasPath(canvasId)}/context/files/${encodeURIComponent(fileId)}`);

export const getContextSources = () => apiJson<ContextSource[]>('/api/canvases/context-sources');
export const addContextLink = (canvasId: string, areaId: string, sourceAreaId: string) =>
  apiJson<ScopeContext>(`${scopePath(canvasId, {kind: 'area', areaId})}/links`, write('POST', {sourceAreaId}));
export const removeContextLink = (canvasId: string, areaId: string, sourceAreaId: string) =>
  apiFetch(`${scopePath(canvasId, {kind: 'area', areaId})}/links/${encodeURIComponent(sourceAreaId)}`, {method: 'DELETE'}).then(() => undefined);
export const getContextReaders = (canvasId: string, areaId: string) =>
  apiJson<ContextReader[]>(`${scopePath(canvasId, {kind: 'area', areaId})}/readers`);

/** `created` is false when the address was already in this scope (the API answers 200 with the existing link); a full scope rejects with an ApiError of status 409. */
export async function addContextWebLink(canvasId: string, scope: PanelScope, url: string, title: string | null) {
  const res = await apiFetch(`${scopePath(canvasId, scope)}/web-links`, write('POST', title ? {url, title} : {url}));
  return {link: (await res.json()) as ContextWebLink, created: res.status === 201};
}
export const removeContextWebLink = (canvasId: string, scope: PanelScope, linkId: string) =>
  apiFetch(`${scopePath(canvasId, scope)}/web-links/${encodeURIComponent(linkId)}`, {method: 'DELETE'}).then(() => undefined);
