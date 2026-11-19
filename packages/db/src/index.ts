import { createAgentPinStore } from './agent-pins';
import { createAgentRequestStore } from './agent-requests';
import { createCanvasStore } from './canvases';
import { createCanvasContextStore } from './canvas-context';
import { createCommunityStore } from './community';
import { createFlowStore } from './flows';
import { createScheduleStore } from './schedules';
import { createContextCompactionStore } from './context-compaction';
import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { createProjectStore } from './projects';
import { dirname } from 'node:path';
import { BrandingSchema, DEFAULT_BRANDING, type Branding } from '../../schemas/src/branding';

// Product-owned data only. Never open the OrgOps database from request handlers.
export function openProductDb(path = '.nest-product/nest.sqlite') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS product_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL,
      actor_id TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL
    );
  `);
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE IF NOT EXISTS product_migrations (name TEXT PRIMARY KEY)');
  db.transaction(() => {
    for (const name of ['001_projects', '002_project_chats', '003_community', '004_personal_agents', '005_integrations', '006_mentions', '007_agent_requests', '008_project_collaboration', '009_connection_projects', '010_project_naming', '011_canvases', '012_canvas_context', '013_agent_pins', '014_links_forks', '015_schedules', '016_triggers', '017_context_compaction', '018_context_web_links']) {
      if (!db.prepare('SELECT name FROM product_migrations WHERE name=?').get(name)) {
        db.exec(readFileSync(new URL(`../migrations/${name}.sql`, import.meta.url), 'utf8'));
        db.prepare('INSERT INTO product_migrations VALUES (?)').run(name);
      }
    }
  })();
  const projects = createProjectStore(db);
  const canvases = createCanvasStore(db);
  function branding(): Branding {
    const row = db.prepare('SELECT value_json FROM product_settings WHERE key = ?').get('branding') as {value_json: string} | undefined;
    try { return row ? BrandingSchema.parse(JSON.parse(row.value_json)) : DEFAULT_BRANDING; }
    catch { return DEFAULT_BRANDING; }
  }
  function saveBranding(value: Branding, actorId: string) {
    const parsed = BrandingSchema.parse(value);
    db.transaction(() => {
      db.prepare('INSERT INTO product_settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json').run('branding', JSON.stringify(parsed));
      db.prepare('INSERT INTO product_audit(type, actor_id, payload_json, created_at) VALUES (?, ?, ?, ?)').run('audit.branding.updated', actorId, JSON.stringify({displayName: parsed.displayName}), Date.now());
    })();
    return parsed;
  }
  return { db, projects, canvases, agentPins:createAgentPinStore(db), canvasContext:createCanvasContextStore(db),  flows:createFlowStore(db), schedules:createScheduleStore(db), agentRequests:createAgentRequestStore(db), community:createCommunityStore(db), contextCompaction:createContextCompactionStore(db), branding, saveBranding, close: () => db.close() };
}
export type ProductDb = ReturnType<typeof openProductDb>;

export { CanvasConflictError, CanvasForbiddenError, CanvasLimitError, type CanvasStore, type PlacedCard } from './canvases';
export { ContextWebLinksFullError, type CanvasContextStore } from './canvas-context';
export { type AgentPinStore } from './agent-pins';
export { type FlowStore, type Delivery, type Fork } from './flows';
export { type ScheduleStore, type ScheduleRecord } from './schedules';
export type { AgentRequestRow, OfferRow } from './agent-requests';
export type { CompactionJob, ContextCompactionStore } from './context-compaction';
