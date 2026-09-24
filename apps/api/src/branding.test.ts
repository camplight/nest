import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "@nest/db";
import { createApp } from "./app";

const directories: string[] = [];
const databases: ReturnType<typeof openDb>[] = [];
function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "nest-branding-"));
  directories.push(root);
  return root;
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("Nest identity and migration compatibility", () => {
  it("issues Nest sessions and accepts legacy clients without accepting an invalid canonical token", async () => {
    const db = openDb(":memory:"); databases.push(db);
    vi.stubEnv("ORGOPS_ADMIN_USER", "legacy-admin");
    vi.stubEnv("ORGOPS_ADMIN_PASS", "legacy-password");
    vi.stubEnv("ORGOPS_RUNNER_TOKEN", "legacy-runner");
    const { app } = createApp({ db, dataDir: tempRoot() });
    const login = await app.request("http://localhost/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "legacy-admin", password: "legacy-password" })
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^nest_session=/);
    const nestCookie = cookie.split(";")[0];
    for (const mixedCookie of [`orgops_session=expired; ${nestCookie}`, `${nestCookie}; orgops_session=expired`]) {
      expect((await app.request("http://localhost/api/auth/me", { headers: { cookie: mixedCookie } })).status).toBe(200);
    }
    const legacyCookie = cookie.split(";")[0].replace("nest_session", "orgops_session");
    expect((await app.request("http://localhost/api/auth/me", { headers: { cookie: legacyCookie } })).status).toBe(200);
    expect((await app.request("http://localhost/api/auth/me", { headers: { cookie: `${legacyCookie}; nest_session=invalid` } })).status).toBe(401);
    for (const header of ["x-nest-runner-token", "x-orgops-runner-token"]) {
      expect((await app.request("http://localhost/api/auth/me", { headers: { [header]: "legacy-runner" } })).status).toBe(200);
    }
    expect((await app.request("http://localhost/api/auth/me", { headers: { "x-nest-runner-token": "wrong", "x-orgops-runner-token": "legacy-runner" } })).status).toBe(401);
    expect((await app.request("http://localhost/api/auth/logout", { method: "POST", headers: { cookie: `orgops_session=expired; ${nestCookie}` } })).status).toBe(200);
    expect((await app.request("http://localhost/api/auth/me", { headers: { cookie: nestCookie } })).status).toBe(401);
  });
  it("reopens the legacy database rather than creating an empty replacement", () => {
    const root = tempRoot();
    const legacyDir = join(root, ".orgops-data"); mkdirSync(legacyDir);
    const legacyPath = join(legacyDir, "orgops.sqlite");
    const seed = openDb(legacyPath); seed.exec("CREATE TABLE migration_marker (value TEXT); INSERT INTO migration_marker VALUES ('preserved')"); seed.close();
    mkdirSync(join(root, ".nest-data", "workspaces"), { recursive: true });
    vi.stubEnv("NEST_PROJECT_ROOT", root);
    const { db } = createApp(); databases.push(db);
    expect(db.prepare("SELECT value FROM migration_marker").get()).toEqual({ value: "preserved" });
    expect(existsSync(join(root, ".nest-data", "nest.sqlite"))).toBe(false);
  });
  it("uses Nest data and canonical configuration for new installs", async () => {
    const root = tempRoot(); vi.stubEnv("NEST_PROJECT_ROOT", root);
    vi.stubEnv("NEST_ADMIN_USER", "nest-admin"); vi.stubEnv("ORGOPS_ADMIN_USER", "old-admin");
    vi.stubEnv("NEST_ADMIN_PASS", "nest-password");
    const { app, db } = createApp(); databases.push(db);
    expect(existsSync(join(root, ".nest-data", "nest.sqlite"))).toBe(true);
    const response = await app.request("http://localhost/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "nest-admin", password: "nest-password" })
    });
    expect(response.status).toBe(200);
  });
});
