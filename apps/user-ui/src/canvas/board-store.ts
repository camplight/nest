// Board state for one open canvas: optimistic layout writes, conflict refresh and the sync loop.
import type {AreaPatch,BoardCard,CanvasArea,CanvasBoard,CanvasCardRow,NewArea} from '@nest/schemas';
import {CanvasConflict,isCanvasForbidden,isCanvasGone,type CardPlacement,type boardApi} from './api';
import {areaMembers} from './geometry';

export type BoardApi = typeof boardApi;
export type BoardStatus = 'loading' | 'ready' | 'gone' | 'error';
export type BoardState = {canvasId: string | null; board: CanvasBoard | null; status: BoardStatus; notice: string | null};
export type BoardOp =
  | {kind: 'moveCard'; channelId: string; x: number; y: number; w?: number}
  | {kind: 'removeCard'; channelId: string}
  | {kind: 'placeCards'; cards: CardPlacement[]; area?: NewArea}
  | {kind: 'createArea'; area: NewArea}
  | {kind: 'patchArea'; areaId: string; patch: Omit<AreaPatch, 'version'>; moveCards?: boolean}
  | {kind: 'deleteArea'; areaId: string};

export const CONFLICT_NOTICE = 'Canvas changed. Refreshed.';
export const FORBIDDEN_NOTICE = 'You can view this canvas but not change it.';
export const FAILED_NOTICE = 'Could not save that change. Try again.';
/** Focus and visibilitychange often fire together; one refresh covers both. */
const REFRESH_DEBOUNCE_MS = 1000;

type PageEvents = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
type StoreOptions = {
  api: BoardApi; now: () => number; intervalMs: number;
  doc?: PageEvents & {visibilityState: DocumentVisibilityState}; win?: PageEvents;
};

const cardFromRow = (card: BoardCard, row: CanvasCardRow): BoardCard => ({...card, x: row.x, y: row.y, w: row.w, version: row.version});
const cardKey = (channelId: string) => `card:${channelId}`;
const areaKey = (areaId: string) => `area:${areaId}`;

/** The cards and areas an op changes, judged against the board it is applied to. */
function touched(board: CanvasBoard, op: BoardOp): string[] {
  switch (op.kind) {
    case 'moveCard': case 'removeCard': return [cardKey(op.channelId)];
    case 'createArea': return [areaKey(op.area.id)];
    case 'deleteArea': return [areaKey(op.areaId)];
    case 'placeCards': return [];
    case 'patchArea': {
      if (!op.moveCards) return [areaKey(op.areaId)];
      const members = areaMembers(op.areaId, board.cards, board.areas);
      return [areaKey(op.areaId), ...[...members.areas].map(areaKey), ...[...members.cards].map(cardKey)];
    }
  }
}

/** The local, unconfirmed result of an op. placeCards waits for the server, which resolves the card contents. */
function optimistic(board: CanvasBoard, op: BoardOp): CanvasBoard {
  switch (op.kind) {
    case 'moveCard':
      return {...board, cards: board.cards.map(c => c.channelId === op.channelId ? {...c, x: op.x, y: op.y, w: op.w ?? c.w} : c)};
    case 'removeCard':
      return {...board, cards: board.cards.filter(c => c.channelId !== op.channelId)};
    case 'placeCards':
      return board;
    case 'createArea':
      return {...board, areas: [...board.areas, {...op.area, tint: op.area.tint ?? 'moss', canvasId: board.canvas.id, version: 0}]};
    case 'patchArea': {
      const before = board.areas.find(a => a.id === op.areaId);
      if (!before) return board;
      const next: CanvasArea = {...before, ...op.patch};
      const dx = next.x - before.x, dy = next.y - before.y;
      if (!op.moveCards || (!dx && !dy)) return {...board, areas: board.areas.map(a => a.id === op.areaId ? next : a)};
      // Mirrors the server: nested areas and the cards whose centre is in this area or one of them travel with it.
      const members = areaMembers(op.areaId, board.cards, board.areas);
      return {
        ...board,
        cards: board.cards.map(c => members.cards.has(c.channelId) ? {...c, x: c.x + dx, y: c.y + dy} : c),
        areas: board.areas.map(a => a.id === op.areaId ? next : members.areas.has(a.id) ? {...a, x: a.x + dx, y: a.y + dy} : a),
      };
    }
    case 'deleteArea':
      return {...board, areas: board.areas.filter(a => a.id !== op.areaId)};
  }
}

export function createBoardStore({api, now, intervalMs, doc = globalThis.document, win = globalThis.window}: StoreOptions) {
  let state: BoardState = {canvasId: null, board: null, status: 'loading', notice: null};
  const listeners = new Set<() => void>();
  const set = (patch: Partial<BoardState>) => { state = {...state, ...patch}; for (const listener of listeners) listener(); };

  let generation = 0; // bumped by open(): responses for an earlier canvas are dropped
  let epoch = 0; // bumped by a conflict reload: queued ops made against the old board are dropped
  let queue: Promise<unknown> = Promise.resolve();
  let pending = 0;
  let refreshing: Promise<void> | null = null;
  let writes = 0; // bumped by apply(): a read that started before a write must not overwrite it
  let refreshingWrites = 0;
  let lastRefreshAt = -Infinity;
  // How many unsettled ops touch each card or area. While a later op on an item is still queued,
  // a confirmation takes only the item's new version: its position is the later op's to set.
  const inFlight = new Map<string, number>();
  const later = (key: string) => (inFlight.get(key) ?? 0) > 1;
  const confirmCard = (card: BoardCard, row: CanvasCardRow): BoardCard => later(cardKey(card.channelId)) ? {...card, version: row.version} : cardFromRow(card, row);
  const confirmArea = (area: CanvasArea, row: CanvasArea): CanvasArea => later(areaKey(area.id)) ? {...area, version: row.version} : row;

  function fail(error: unknown, gen: number) {
    if (gen !== generation) return true;
    if (isCanvasGone(error)) { set({status: 'gone', board: null}); return true; }
    return false;
  }

  async function open(canvasId: string) {
    if (state.canvasId === canvasId && state.status === 'ready') return refresh();
    const gen = ++generation;
    epoch++;
    set({canvasId, board: null, status: 'loading', notice: null});
    try {
      const board = await api.getBoard(canvasId);
      if (gen !== generation) return;
      if ('unchanged' in board) throw Error('Unexpected unchanged board');
      set({board, status: 'ready'});
    } catch (error) {
      if (!fail(error, gen)) set({status: 'error'});
    }
  }

  /** Re-reads the board with its etag; `{unchanged:true}` leaves the state (and board identity) untouched. */
  function refresh(): Promise<void> {
    if (refreshing) return refreshingWrites === writes ? refreshing : refreshing.then(refresh);
    const {canvasId, board} = state;
    if (!canvasId || !board || state.status !== 'ready' || pending > 0) return Promise.resolve();
    const gen = generation, startedWrites = writes;
    refreshingWrites = writes;
    lastRefreshAt = now();
    refreshing = (async () => {
      try {
        const next = await api.getBoard(canvasId, board.etag);
        // A write that started meanwhile owns the board until it settles and refreshes itself.
        if (gen !== generation || pending > 0 || startedWrites !== writes || 'unchanged' in next) return;
        set({board: next});
      } catch (error) {
        fail(error, gen); // anything else is transient: keep the board and try again next tick
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  async function reload(canvasId: string, gen: number, notice: string) {
    epoch++;
    try {
      const board = await api.getBoard(canvasId);
      if (gen !== generation || 'unchanged' in board) return;
      set({board, notice});
    } catch (error) {
      if (!fail(error, gen)) set({notice});
    }
  }

  async function send(canvasId: string, op: BoardOp) {
    const board = state.board!;
    switch (op.kind) {
      case 'moveCard': {
        const card = board.cards.find(c => c.channelId === op.channelId);
        if (!card) return;
        const row = await api.moveCard(canvasId, op.channelId, {x: op.x, y: op.y, ...(op.w === undefined ? {} : {w: op.w}), version: card.version});
        set({board: {...state.board!, cards: state.board!.cards.map(c => c.channelId === row.channelId ? confirmCard(c, row) : c)}});
        return;
      }
      case 'removeCard': {
        const card = board.cards.find(c => c.channelId === op.channelId);
        if (card) await api.removeCard(canvasId, op.channelId, card.version);
        return;
      }
      case 'placeCards':
        set({board: await api.placeCards(canvasId, op.cards, op.area)});
        return;
      case 'createArea': {
        const area = await api.createArea(canvasId, op.area);
        set({board: {...state.board!, areas: state.board!.areas.map(a => a.id === area.id ? confirmArea(a, area) : a)}});
        return;
      }
      case 'patchArea': {
        const area = board.areas.find(a => a.id === op.areaId);
        if (!area) return;
        const result = await api.patchArea(canvasId, op.areaId, {...op.patch, version: area.version}, Boolean(op.moveCards));
        const rows = new Map(result.cards.map(row => [row.channelId, row]));
        const areas = new Map([...result.areas, result.area].map(a => [a.id, a]));
        const current = state.board!;
        set({board: {...current, areas: current.areas.map(a => areas.has(a.id) ? confirmArea(a, areas.get(a.id)!) : a), cards: current.cards.map(c => rows.has(c.channelId) ? confirmCard(c, rows.get(c.channelId)!) : c)}});
        return;
      }
      case 'deleteArea': {
        const area = board.areas.find(a => a.id === op.areaId);
        if (area) await api.deleteArea(canvasId, op.areaId, area.version);
        return;
      }
    }
  }

  /**
   * Shows the op at once, then sends it. Writes go one at a time so each uses the version the
   * previous one confirmed. Resolves true when the server accepted it.
   */
  function apply(op: BoardOp): Promise<boolean> {
    const {canvasId, board} = state;
    if (!canvasId || !board || state.status !== 'ready') return Promise.resolve(false);
    const gen = generation, opEpoch = epoch;
    const keys = touched(board, op);
    for (const key of keys) inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
    set({board: optimistic(board, op), notice: null});
    pending++;
    writes++;
    const run = queue.then(async () => {
      if (gen !== generation || opEpoch !== epoch || !state.board) return false;
      try {
        await send(canvasId, op);
        return true;
      } catch (error) {
        if (fail(error, gen)) return false;
        await reload(canvasId, gen, error instanceof CanvasConflict ? CONFLICT_NOTICE : isCanvasForbidden(error) ? FORBIDDEN_NOTICE : FAILED_NOTICE);
        return false;
      }
    }).finally(() => {
      pending--;
      for (const key of keys) { const n = (inFlight.get(key) ?? 1) - 1; if (n > 0) inFlight.set(key, n); else inFlight.delete(key); }
    });
    queue = run;
    // Layout writes bump the canvas version (rename, sharing and delete use it), so re-read once writes settle.
    return run.then(async ok => { if (ok && pending === 0) await refresh(); return ok; });
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  const tick = () => { if (doc?.visibilityState === 'visible') void refresh(); };
  const soon = () => { if (now() - lastRefreshAt >= REFRESH_DEBOUNCE_MS) void refresh(); };
  const visibility = () => {
    if (doc?.visibilityState === 'visible') {
      if (!timer) timer = setInterval(tick, intervalMs);
      soon();
    } else if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
  function start() {
    stop();
    doc?.addEventListener('visibilitychange', visibility);
    win?.addEventListener('focus', soon);
    if (doc?.visibilityState === 'visible') timer = setInterval(tick, intervalMs);
  }
  function stop() {
    doc?.removeEventListener('visibilitychange', visibility);
    win?.removeEventListener('focus', soon);
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    snapshot: () => state,
    open, refresh, apply, start, stop,
    clearNotice() { if (state.notice) set({notice: null}); },
  };
}
export type BoardStore = ReturnType<typeof createBoardStore>;
