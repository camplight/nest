import { createCommunityStore } from './community';
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
    for (const name of ['001_projects', '002_project_chats', '003_community']) {
      if (!db.prepare('SELECT name FROM product_migrations WHERE name=?').get(name)) {
        db.exec(readFileSync(new URL(`../migrations/${name}.sql`, import.meta.url), 'utf8'));
        db.prepare('INSERT INTO product_migrations VALUES (?)').run(name);
      }
    }
  })();
  const projects = createProjectStore(db);
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
  return { db, projects, community:createCommunityStore(db), branding, saveBranding, close: () => db.close() };
}
export type ProductDb = ReturnType<typeof openProductDb>;
