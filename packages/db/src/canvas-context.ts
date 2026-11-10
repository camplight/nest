import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import {
  MAX_CONTEXT_BYTES_PER_CANVAS, MAX_CONTEXT_FILES_PER_SCOPE, MAX_LINKS_PER_AREA,
  type ChatHome, type ContextFile, type ContextScope,
} from '../../schemas/src/canvas-context';
import { CanvasConflictError, CanvasLimitError } from './canvases';

export type NewContextFile = { id: string; name: string; mime: string; size: number; storageKey: string };
export type StoredContextFile = { canvasId: string; scope: ContextScope; storageKey: string; name: string; mime: string; size: number };

export function createCanvasContextStore(db: Database.Database) {
  const scopeId = (s: ContextScope) => (s.kind === 'canvas' ? s.canvasId : s.areaId);
  const fileColumns = 'id, name, mime, size, uploaded_by AS uploadedBy, uploaded_at AS uploadedAt';

  function audit(verb: string, actor: string, payload: unknown) {
    db.prepare('INSERT INTO product_audit(type,actor_id,payload_json,created_at) VALUES (?,?,?,?)').run(`audit.canvas.context.${verb}`, actor, JSON.stringify(payload), Date.now());
  }
  function files(scope: ContextScope) {
    return db.prepare(`SELECT ${fileColumns} FROM product_canvas_context_files WHERE scope_kind=? AND scope_id=? ORDER BY uploaded_at, id`).all(scope.kind, scopeId(scope)) as ContextFile[];
  }
  function get(scope: ContextScope) {
    const row = db.prepare('SELECT notes, version FROM product_canvas_context WHERE scope_kind=? AND scope_id=?').get(scope.kind, scopeId(scope)) as { notes: string; version: number } | undefined;
    return { notes: row?.notes ?? '', version: row?.version ?? 0, files: files(scope) };
  }
  // Notes never appear in the audit payload, only ids.
  function setNotes(scope: ContextScope, notes: string, version: number, actor: string) {
    return db.transaction(() => {
      const now = Date.now();
      const exists = db.prepare('SELECT 1 FROM product_canvas_context WHERE scope_kind=? AND scope_id=?').get(scope.kind, scopeId(scope));
      let changed: number;
      if (exists) {
        changed = db.prepare('UPDATE product_canvas_context SET notes=?, version=version+1, updated_by=?, updated_at=? WHERE scope_kind=? AND scope_id=? AND version=?')
          .run(notes, actor, now, scope.kind, scopeId(scope), version).changes;
      } else if (version === 0) {
        db.prepare('INSERT INTO product_canvas_context(scope_kind,scope_id,canvas_id,notes,version,updated_by,updated_at) VALUES (?,?,?,?,1,?,?)')
          .run(scope.kind, scopeId(scope), scope.canvasId, notes, actor, now);
        changed = 1;
      } else changed = 0;
      if (!changed) throw new CanvasConflictError(null);
      audit('notes.set', actor, { canvasId: scope.canvasId, scope: scope.kind, scopeId: scopeId(scope) });
      const { notes: saved, version: next } = get(scope);
      return { notes: saved, version: next };
    })();
  }

  function canvasBytes(canvasId: string) {
    return (db.prepare('SELECT COALESCE(SUM(size),0) AS n FROM product_canvas_context_files WHERE canvas_id=?').get(canvasId) as { n: number }).n;
  }
  function addFile(scope: ContextScope, input: NewContextFile, actor: string) {
    return db.transaction(() => {
      const count = (db.prepare('SELECT COUNT(*) AS n FROM product_canvas_context_files WHERE scope_kind=? AND scope_id=?').get(scope.kind, scopeId(scope)) as { n: number }).n;
      if (count >= MAX_CONTEXT_FILES_PER_SCOPE) throw new CanvasLimitError(`A context can hold at most ${MAX_CONTEXT_FILES_PER_SCOPE} files`);
      if (canvasBytes(scope.canvasId) + input.size > MAX_CONTEXT_BYTES_PER_CANVAS) throw new CanvasLimitError('A canvas can hold at most 200 MiB of context files');
      db.prepare('INSERT INTO product_canvas_context_files(id,canvas_id,scope_kind,scope_id,name,mime,size,storage_key,uploaded_by,uploaded_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(input.id, scope.canvasId, scope.kind, scopeId(scope), input.name, input.mime, input.size, input.storageKey, actor, Date.now());
      audit('file.added', actor, { canvasId: scope.canvasId, scope: scope.kind, scopeId: scopeId(scope), fileId: input.id });
      return db.prepare(`SELECT ${fileColumns} FROM product_canvas_context_files WHERE id=?`).get(input.id) as ContextFile;
    })();
  }
  function file(fileId: string): StoredContextFile | null {
    const r = db.prepare('SELECT canvas_id AS canvasId, scope_kind AS kind, scope_id AS sid, storage_key AS storageKey, name, mime, size FROM product_canvas_context_files WHERE id=?')
      .get(fileId) as { canvasId: string; kind: 'canvas' | 'area'; sid: string; storageKey: string; name: string; mime: string; size: number } | undefined;
    if (!r) return null;
    const scope: ContextScope = r.kind === 'canvas' ? { kind: 'canvas', canvasId: r.canvasId } : { kind: 'area', canvasId: r.canvasId, areaId: r.sid };
    return { canvasId: r.canvasId, scope, storageKey: r.storageKey, name: r.name, mime: r.mime, size: r.size };
  }
  function removeFile(fileId: string, actor: string) {
    return db.transaction(() => {
      const found = file(fileId);
      if (!found) throw new CanvasConflictError(null);
      db.prepare('DELETE FROM product_canvas_context_files WHERE id=?').run(fileId);
      audit('file.removed', actor, { canvasId: found.canvasId, scope: found.scope.kind, scopeId: scopeId(found.scope), fileId });
      return { storageKey: found.storageKey };
    })();
  }

  function links(areaId: string) {
    return db.prepare('SELECT source_area_id AS sourceAreaId, linked_by AS linkedBy, linked_at AS linkedAt FROM product_area_context_refs WHERE area_id=? ORDER BY linked_at, source_area_id').all(areaId) as { sourceAreaId: string; linkedBy: string; linkedAt: number }[];
  }
  // Only direct refs are stored, so links stay one level deep.
  function link(areaId: string, sourceAreaId: string, actor: string) {
    db.transaction(() => {
      if (areaId === sourceAreaId) throw new CanvasLimitError('An area cannot use its own context');
      if (db.prepare('SELECT 1 FROM product_area_context_refs WHERE area_id=? AND source_area_id=?').get(areaId, sourceAreaId)) return;
      const n = (db.prepare('SELECT COUNT(*) AS n FROM product_area_context_refs WHERE area_id=?').get(areaId) as { n: number }).n;
      if (n >= MAX_LINKS_PER_AREA) throw new CanvasLimitError(`An area can use at most ${MAX_LINKS_PER_AREA} other areas`);
      db.prepare('INSERT INTO product_area_context_refs(area_id,source_area_id,linked_by,linked_at) VALUES (?,?,?,?)').run(areaId, sourceAreaId, actor, Date.now());
      audit('link.added', actor, { areaId, sourceAreaId });
    })();
  }
  function unlink(areaId: string, sourceAreaId: string, actor: string) {
    db.transaction(() => {
      if (db.prepare('DELETE FROM product_area_context_refs WHERE area_id=? AND source_area_id=?').run(areaId, sourceAreaId).changes) {
        audit('link.removed', actor, { areaId, sourceAreaId });
      }
    })();
  }
  function usedBy(sourceAreaId: string) {
    return db.prepare(`SELECT r.area_id AS areaId, a.canvas_id AS canvasId FROM product_area_context_refs r
      JOIN product_canvas_areas a ON a.id=r.area_id WHERE r.source_area_id=? ORDER BY r.linked_at, r.area_id`).all(sourceAreaId) as { areaId: string; canvasId: string }[];
  }

  function home(channelId: string): ChatHome | null {
    return (db.prepare('SELECT canvas_id AS canvasId, area_id AS areaId FROM product_chat_home WHERE channel_id=?').get(channelId) as ChatHome | undefined) ?? null;
  }
  function setHome(channelId: string, value: ChatHome, actor: string) {
    db.transaction(() => {
      db.prepare(`INSERT INTO product_chat_home(channel_id,canvas_id,area_id,set_by,set_at) VALUES (?,?,?,?,?)
        ON CONFLICT(channel_id) DO UPDATE SET canvas_id=excluded.canvas_id, area_id=excluded.area_id, set_by=excluded.set_by, set_at=excluded.set_at`)
        .run(channelId, value.canvasId, value.areaId, actor, Date.now());
      audit('home.set', actor, { channelId, canvasId: value.canvasId, areaId: value.areaId });
    })();
  }
  function homesIn(canvasId: string) {
    const rows = db.prepare('SELECT channel_id AS channelId, canvas_id AS canvasId, area_id AS areaId FROM product_chat_home WHERE canvas_id=? ORDER BY channel_id').all(canvasId) as (ChatHome & { channelId: string })[];
    return new Map(rows.map(r => [r.channelId, { canvasId: r.canvasId, areaId: r.areaId } as ChatHome]));
  }

  // Disk cleanup: call these BEFORE deleting the canvas or area, because the delete removes the rows.
  function storageKeysFor(canvasId: string) {
    return (db.prepare('SELECT storage_key AS k FROM product_canvas_context_files WHERE canvas_id=? ORDER BY storage_key').all(canvasId) as { k: string }[]).map(r => r.k);
  }
  function storageKeysForArea(areaId: string) {
    return (db.prepare("SELECT storage_key AS k FROM product_canvas_context_files WHERE scope_kind='area' AND scope_id=? ORDER BY storage_key").all(areaId) as { k: string }[]).map(r => r.k);
  }

  // Only the sha256 hash is stored, never the key itself.
  function keyFor(agentName: string) {
    return (db.prepare('SELECT id, created_at AS createdAt FROM product_context_tokens WHERE agent_name=? AND revoked_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1').get(agentName) as { id: string; createdAt: number } | undefined) ?? null;
  }
  function saveKey(agentName: string, tokenHash: string) {
    db.transaction(() => {
      const now = Date.now();
      db.prepare('UPDATE product_context_tokens SET revoked_at=? WHERE agent_name=? AND revoked_at IS NULL').run(now, agentName);
      db.prepare('INSERT INTO product_context_tokens(id,token_hash,agent_name,created_at) VALUES (?,?,?,?)').run(randomUUID(), tokenHash, agentName, now);
      audit('key.saved', 'system', { agentName });
    })();
  }
  function agentForKey(tokenHash: string) {
    return (db.prepare('SELECT agent_name AS a FROM product_context_tokens WHERE token_hash=? AND revoked_at IS NULL').get(tokenHash) as { a: string } | undefined)?.a ?? null;
  }
  // Revokes exactly one key, e.g. one whose secret could not be installed in the engine.
  function revokeKey(tokenHash: string) {
    db.transaction(() => {
      const row = db.prepare('SELECT agent_name AS a FROM product_context_tokens WHERE token_hash=? AND revoked_at IS NULL').get(tokenHash) as { a: string } | undefined;
      if (!row) return;
      db.prepare('UPDATE product_context_tokens SET revoked_at=? WHERE token_hash=?').run(Date.now(), tokenHash);
      audit('key.revoked', 'system', { agentName: row.a });
    })();
  }
  function markSkillEnabled(agentName: string) {
    db.transaction(() => {
      if (db.prepare('INSERT OR IGNORE INTO product_context_agents(agent_name,skill_enabled_at) VALUES (?,?)').run(agentName, Date.now()).changes) {
        audit('skill.enabled', 'system', { agentName });
      }
    })();
  }
  function skillEnabled(agentName: string) {
    return !!db.prepare('SELECT 1 FROM product_context_agents WHERE agent_name=?').get(agentName);
  }

  return {
    get, setNotes, addFile, file, removeFile, canvasBytes, links, link, unlink, usedBy, home, setHome, homesIn,
    storageKeysFor, storageKeysForArea, keyFor, saveKey, revokeKey, agentForKey, markSkillEnabled, skillEnabled,
  };
}
export type CanvasContextStore = ReturnType<typeof createCanvasContextStore>;
