import type Database from 'better-sqlite3';
import {
  areaFor, CARD_HEIGHT, MAX_AREAS, MAX_CANVASES_PER_OWNER, MAX_CARDS,
  type AreaPatch, type Canvas, type CanvasArea, type CanvasCardRow, type CanvasSharing, type CardPatch, type NewArea, type NewCanvas,
} from '../../schemas/src/canvas';

export class CanvasConflictError extends Error {
  constructor(readonly current: Canvas | CanvasArea | CanvasCardRow | null) { super('Canvas item was changed by someone else'); this.name = 'CanvasConflictError'; }
}
export class CanvasForbiddenError extends Error {
  constructor(message = 'Your role does not allow this change') { super(message); this.name = 'CanvasForbiddenError'; }
}
export class CanvasLimitError extends Error {
  constructor(message: string) { super(message); this.name = 'CanvasLimitError'; }
}

export type PlacedCard = { channelId: string; projectId: string | null; x: number; y: number; w: number; ownerLabel: string };

export function createCanvasStore(db: Database.Database) {
  const roleSql = `CASE WHEN c.owner_id=@h THEN 'owner' ELSE m.role END`;
  const canvasSelect = `SELECT c.id, c.owner_id AS ownerId, c.name, c.visibility, c.version, c.created_at AS createdAt, c.updated_at AS updatedAt, ${roleSql} AS role
    FROM product_canvases c LEFT JOIN product_canvas_members m ON m.canvas_id=c.id AND m.human_id=@h`;
  const areaColumns = 'id, canvas_id AS canvasId, title, x, y, w, h, tint, version';
  const cardColumns = 'canvas_id AS canvasId, channel_id AS channelId, project_id AS projectId, x, y, w, version, placed_by AS placedBy, placed_at AS placedAt, owner_label AS ownerLabel';

  function audit(type: string, actor: string, payload: unknown) {
    db.prepare('INSERT INTO product_audit(type,actor_id,payload_json,created_at) VALUES (?,?,?,?)').run(type, actor, JSON.stringify(payload), Date.now());
  }
  function list(humanId: string) {
    return db.prepare(`${canvasSelect} WHERE c.owner_id=@h OR m.human_id IS NOT NULL ORDER BY c.created_at DESC, c.id`).all({ h: humanId }) as Canvas[];
  }
  function get(canvasId: string, humanId: string) {
    return (db.prepare(`${canvasSelect} WHERE c.id=@id AND (c.owner_id=@h OR m.human_id IS NOT NULL)`).get({ id: canvasId, h: humanId }) as Canvas | undefined) ?? null;
  }
  // No access and a missing canvas both look the same to callers; routes should call get() first for a 404.
  function access(canvasId: string, actor: string, need: 'edit' | 'owner') {
    const canvas = get(canvasId, actor);
    if (!canvas) throw new CanvasForbiddenError('No access to this canvas');
    if (need === 'owner' ? canvas.role !== 'owner' : canvas.role === 'view') throw new CanvasForbiddenError();
    return canvas;
  }
  function touch(canvasId: string) {
    db.prepare('UPDATE product_canvases SET version=version+1, updated_at=? WHERE id=?').run(Date.now(), canvasId);
  }
  function areas(canvasId: string) {
    return db.prepare(`SELECT ${areaColumns} FROM product_canvas_areas WHERE canvas_id=? ORDER BY created_at, id`).all(canvasId) as CanvasArea[];
  }
  function area(canvasId: string, areaId: string) {
    return db.prepare(`SELECT ${areaColumns} FROM product_canvas_areas WHERE canvas_id=? AND id=?`).get(canvasId, areaId) as CanvasArea | undefined;
  }
  function cards(canvasId: string) {
    return db.prepare(`SELECT ${cardColumns} FROM product_canvas_cards WHERE canvas_id=? ORDER BY placed_at, channel_id`).all(canvasId) as CanvasCardRow[];
  }
  function card(canvasId: string, channelId: string) {
    return db.prepare(`SELECT ${cardColumns} FROM product_canvas_cards WHERE canvas_id=? AND channel_id=?`).get(canvasId, channelId) as CanvasCardRow | undefined;
  }
  function members(canvasId: string) {
    return db.prepare('SELECT human_id AS humanId, role FROM product_canvas_members WHERE canvas_id=? ORDER BY human_id').all(canvasId) as { humanId: string; role: 'edit' | 'view' }[];
  }

  function create(input: NewCanvas, ownerId: string) {
    return db.transaction(() => {
      const owned = (db.prepare('SELECT COUNT(*) AS n FROM product_canvases WHERE owner_id=?').get(ownerId) as { n: number }).n;
      if (owned >= MAX_CANVASES_PER_OWNER) throw new CanvasLimitError(`You can own at most ${MAX_CANVASES_PER_OWNER} canvases`);
      const now = Date.now();
      db.prepare("INSERT INTO product_canvases(id,owner_id,name,visibility,version,created_at,updated_at) VALUES (?,?,?,'private',0,?,?)").run(input.id, ownerId, input.name, now, now);
      audit('audit.canvas.created', ownerId, { canvasId: input.id });
      return get(input.id, ownerId)!;
    })();
  }
  function rename(canvasId: string, name: string, version: number, actor: string) {
    return db.transaction(() => {
      access(canvasId, actor, 'owner');
      const changed = db.prepare('UPDATE product_canvases SET name=?, version=version+1, updated_at=? WHERE id=? AND version=?').run(name, Date.now(), canvasId, version).changes;
      if (!changed) throw new CanvasConflictError(get(canvasId, actor));
      audit('audit.canvas.renamed', actor, { canvasId });
      return get(canvasId, actor)!;
    })();
  }
  function remove(canvasId: string, version: number, actor: string) {
    db.transaction(() => {
      access(canvasId, actor, 'owner');
      const changed = db.prepare('DELETE FROM product_canvases WHERE id=? AND version=?').run(canvasId, version).changes;
      if (!changed) throw new CanvasConflictError(get(canvasId, actor));
      audit('audit.canvas.deleted', actor, { canvasId });
    })();
  }
  function setSharing(canvasId: string, input: CanvasSharing, actor: string) {
    return db.transaction(() => {
      const canvas = access(canvasId, actor, 'owner');
      const changed = db.prepare('UPDATE product_canvases SET visibility=?, version=version+1, updated_at=? WHERE id=? AND version=?').run(input.visibility, Date.now(), canvasId, input.version).changes;
      if (!changed) throw new CanvasConflictError(get(canvasId, actor));
      db.prepare('DELETE FROM product_canvas_members WHERE canvas_id=?').run(canvasId);
      if (input.visibility === 'shared') {
        const insert = db.prepare('INSERT OR REPLACE INTO product_canvas_members(canvas_id,human_id,role) VALUES (?,?,?)');
        for (const m of input.members) if (m.humanId !== canvas.ownerId) insert.run(canvasId, m.humanId, m.role);
      }
      audit('audit.canvas.shared', actor, { canvasId, visibility: input.visibility, members: input.visibility === 'shared' ? input.members.length : 0 });
      return get(canvasId, actor)!;
    })();
  }

  function insertArea(canvasId: string, input: NewArea, actor: string) {
    const count = (db.prepare('SELECT COUNT(*) AS n FROM product_canvas_areas WHERE canvas_id=?').get(canvasId) as { n: number }).n;
    if (count >= MAX_AREAS) throw new CanvasLimitError(`A canvas can hold at most ${MAX_AREAS} areas`);
    const now = Date.now();
    db.prepare('INSERT INTO product_canvas_areas(id,canvas_id,title,x,y,w,h,tint,version,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,0,?,?,?)')
      .run(input.id, canvasId, input.title, input.x, input.y, input.w, input.h, input.tint ?? 'moss', actor, now, now);
    audit('audit.canvas.area.created', actor, { canvasId, areaId: input.id });
    return area(canvasId, input.id)!;
  }
  function createArea(canvasId: string, input: NewArea, actor: string) {
    return db.transaction(() => {
      access(canvasId, actor, 'edit');
      const created = insertArea(canvasId, input, actor);
      touch(canvasId);
      return created;
    })();
  }
  const contains = (outer: CanvasArea, inner: CanvasArea) =>
    inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
  function patchArea(canvasId: string, areaId: string, patch: AreaPatch, actor: string, options: { moveCards: boolean }) {
    return db.transaction(() => {
      access(canvasId, actor, 'edit');
      const before = area(canvasId, areaId);
      if (!before || before.version !== patch.version) throw new CanvasConflictError(before ?? null);
      const next = { ...before, title: patch.title ?? before.title, x: patch.x ?? before.x, y: patch.y ?? before.y, w: patch.w ?? before.w, h: patch.h ?? before.h, tint: patch.tint ?? before.tint };
      const dx = next.x - before.x, dy = next.y - before.y;
      const movedCards: string[] = [];
      const movedAreas: string[] = [];
      if (options.moveCards && (dx || dy)) {
        // Membership is judged against the layout before the move: the area's own cards, plus
        // cards and areas nested inside it travel together.
        const all = areas(canvasId);
        const nested = new Set(all.filter(a => a.id !== areaId && contains(before, a)).map(a => a.id));
        const shift = db.prepare('UPDATE product_canvas_cards SET x=x+?, y=y+?, version=version+1 WHERE canvas_id=? AND channel_id=?');
        for (const c of cards(canvasId)) {
          const owner = areaFor({ x: c.x + c.w / 2, y: c.y + CARD_HEIGHT / 2 }, all);
          if (owner && (owner.id === areaId || nested.has(owner.id))) { shift.run(dx, dy, canvasId, c.channelId); movedCards.push(c.channelId); }
        }
        const shiftArea = db.prepare('UPDATE product_canvas_areas SET x=x+?, y=y+?, version=version+1, updated_at=? WHERE id=?');
        for (const id of nested) { shiftArea.run(dx, dy, Date.now(), id); movedAreas.push(id); }
      }
      db.prepare('UPDATE product_canvas_areas SET title=?,x=?,y=?,w=?,h=?,tint=?,version=version+1,updated_at=? WHERE id=? AND version=?')
        .run(next.title, next.x, next.y, next.w, next.h, next.tint, Date.now(), areaId, patch.version);
      touch(canvasId);
      audit('audit.canvas.area.updated', actor, { canvasId, areaId });
      return {
        area: area(canvasId, areaId)!,
        cards: movedCards.map(id => card(canvasId, id)!),
        areas: movedAreas.map(id => area(canvasId, id)!),
      };
    })();
  }
  function removeArea(canvasId: string, areaId: string, version: number, actor: string) {
    db.transaction(() => {
      access(canvasId, actor, 'edit');
      const changed = db.prepare('DELETE FROM product_canvas_areas WHERE canvas_id=? AND id=? AND version=?').run(canvasId, areaId, version).changes;
      if (!changed) throw new CanvasConflictError(area(canvasId, areaId) ?? null);
      // Context rows have no foreign key to the area, so they go in this transaction. Disk files are
      // removed by the API from canvasContext.storageKeysForArea(), which must be read BEFORE this call.
      db.prepare("DELETE FROM product_canvas_context WHERE scope_kind='area' AND scope_id=?").run(areaId);
      db.prepare("DELETE FROM product_canvas_context_files WHERE scope_kind='area' AND scope_id=?").run(areaId);
      db.prepare("DELETE FROM product_canvas_context_web_links WHERE scope_kind='area' AND scope_id=?").run(areaId);
      touch(canvasId);
      audit('audit.canvas.area.removed', actor, { canvasId, areaId });
    })();
  }

  // Idempotent per (canvas, channel): an already-placed card keeps its position and placedBy.
  function placeCards(canvasId: string, input: PlacedCard[], newArea: NewArea | undefined, actor: string) {
    return db.transaction(() => {
      access(canvasId, actor, 'edit');
      const existing = db.prepare('SELECT 1 FROM product_canvas_cards WHERE canvas_id=? AND channel_id=?');
      const fresh = new Map<string, PlacedCard>();
      for (const c of input) if (!existing.get(canvasId, c.channelId) && !fresh.has(c.channelId)) fresh.set(c.channelId, c);
      const total = (db.prepare('SELECT COUNT(*) AS n FROM product_canvas_cards WHERE canvas_id=?').get(canvasId) as { n: number }).n;
      if (total + fresh.size > MAX_CARDS) throw new CanvasLimitError(`A canvas can hold at most ${MAX_CARDS} cards`);
      if (newArea) insertArea(canvasId, newArea, actor);
      const insert = db.prepare('INSERT INTO product_canvas_cards(canvas_id,channel_id,project_id,x,y,w,version,placed_by,placed_at,owner_label) VALUES (?,?,?,?,?,?,0,?,?,?)');
      const now = Date.now();
      for (const c of fresh.values()) insert.run(canvasId, c.channelId, c.projectId, c.x, c.y, c.w, actor, now, c.ownerLabel);
      if (fresh.size || newArea) touch(canvasId);
      if (fresh.size) audit('audit.canvas.cards.placed', actor, { canvasId, channelIds: [...fresh.keys()] });
      return cards(canvasId).filter(c => input.some(i => i.channelId === c.channelId));
    })();
  }
  function moveCard(canvasId: string, channelId: string, patch: CardPatch, actor: string) {
    return db.transaction(() => {
      access(canvasId, actor, 'edit');
      const changed = db.prepare('UPDATE product_canvas_cards SET x=?,y=?,w=COALESCE(?,w),version=version+1 WHERE canvas_id=? AND channel_id=? AND version=?')
        .run(patch.x, patch.y, patch.w ?? null, canvasId, channelId, patch.version).changes;
      if (!changed) throw new CanvasConflictError(card(canvasId, channelId) ?? null);
      touch(canvasId);
      audit('audit.canvas.card.moved', actor, { canvasId, channelId });
      return card(canvasId, channelId)!;
    })();
  }
  function removeCard(canvasId: string, channelId: string, version: number, actor: string) {
    db.transaction(() => {
      access(canvasId, actor, 'edit');
      const changed = db.prepare('DELETE FROM product_canvas_cards WHERE canvas_id=? AND channel_id=? AND version=?').run(canvasId, channelId, version).changes;
      if (!changed) throw new CanvasConflictError(card(canvasId, channelId) ?? null);
      touch(canvasId);
      audit('audit.canvas.card.removed', actor, { canvasId, channelId });
    })();
  }

  function hidden(humanId: string) {
    return (db.prepare('SELECT channel_id AS channelId FROM product_loose_hidden WHERE human_id=? ORDER BY channel_id').all(humanId) as { channelId: string }[]).map(r => r.channelId);
  }
  function setHidden(humanId: string, channelIds: string[], isHidden: boolean) {
    db.transaction(() => {
      const stmt = isHidden
        ? db.prepare('INSERT OR IGNORE INTO product_loose_hidden(human_id,channel_id,hidden_at) VALUES (?,?,?)')
        : db.prepare('DELETE FROM product_loose_hidden WHERE human_id=? AND channel_id=?');
      for (const id of channelIds) isHidden ? stmt.run(humanId, id, Date.now()) : stmt.run(humanId, id);
    })();
  }
  return { list, get, create, rename, remove, setSharing, members, areas, createArea, patchArea, removeArea, cards, placeCards, moveCard, removeCard, hidden, setHidden };
}
export type CanvasStore = ReturnType<typeof createCanvasStore>;
