import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { schema } from "./schema";
export { CHANNEL_KINDS, isChannelKind, type ChannelKind } from "./channel-kinds";
export {
  CHANNEL_VISIBILITY,
  AGENT_VISIBILITY,
  isChannelVisibility,
  isAgentVisibility,
  type ChannelVisibility,
  type AgentVisibility,
} from "./visibility";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));

export type NestDb = InstanceType<typeof Database>;
export type NestDrizzleDb = ReturnType<typeof createDrizzleDb>;

export const DEFAULT_DB_PATH = ".nest-data/nest.sqlite";

export function openDb(path = existsSync(DEFAULT_DB_PATH) || !existsSync(".orgops-data/orgops.sqlite")
  ? DEFAULT_DB_PATH : ".orgops-data/orgops.sqlite"): NestDb {
  if (path !== ":memory:") {
    // Ensure parent directory exists for file-based SQLite paths.
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  configureDb(db);
  return db;
}

export function configureDb(db: NestDb) {
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA synchronous=NORMAL;");
  db.exec("PRAGMA busy_timeout=5000;");
  db.exec("PRAGMA foreign_keys=ON;");
}

export function createDrizzleDb(db: NestDb) {
  return drizzle(db, { schema });
}

export function migrate(db: NestDb, migrationsDir = join(THIS_DIR, "..", "migrations")) {
  if (!existsSync(migrationsDir)) {
    return;
  }
  db.exec(
    "CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)"
  );

  const applied = db.prepare("SELECT id FROM migrations").all() as Array<{ id: string }>;
  const appliedIds = new Set(applied.map((row) => row.id));

  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  const now = Date.now();
  const insert = db.prepare("INSERT INTO migrations (id, applied_at) VALUES (?, ?)");

  for (const file of files) {
    if (appliedIds.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), "utf-8");
    db.exec(sql);
    insert.run(file, now);
  }
}

export { schema };
