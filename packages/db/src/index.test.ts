import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb, migrate } from "./index";

describe("db", () => {
  it("runs migrations and creates tables", ({ onTestFinished }) => {
    const dir = mkdtempSync(join(tmpdir(), "nest-db-test-"));
    const dbPath = join(dir, "test.sqlite");
    const db = openDb(dbPath);
    onTestFinished(() => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });
    migrate(db);
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'")
      .get();
    expect(row).toBeTruthy();
    const keysRow = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='integration_keys'",
      )
      .get();
    expect(keysRow).toBeTruthy();
    const embedRow = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='embed_conversations'",
      )
      .get();
    expect(embedRow).toBeTruthy();
  });
});
