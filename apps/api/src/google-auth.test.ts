import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OAuth2Client } from "google-auth-library";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp as createEngine } from "../../../vendor/orgops/apps/api/src/app";
import { createOrgOpsClient } from "@nest/orgops-client";
import { createApp } from "./app";

let dir: string,
  engine: ReturnType<typeof createEngine>,
  product: ReturnType<typeof createApp>,
  owner: string;
const settings = {
  enabled: true,
  allowedDomain: "example.com",
  teamName: "Example team",
};
beforeEach(async () => {
  vi.stubEnv("ORGOPS_GOOGLE_CLIENT_ID", "test.apps.googleusercontent.com");
  vi.stubEnv("ORGOPS_GOOGLE_CLIENT_SECRET", "test-secret");
  vi.stubEnv(
    "ORGOPS_GOOGLE_REDIRECT_URI",
    "https://nest.example/api/auth/google/callback",
  );
  dir = mkdtempSync(join(tmpdir(), "nest-google-"));
  engine = createEngine({
    dbPath: join(dir, "engine.sqlite"),
    dataDir: dir,
    projectRoot: dir,
    adminUser: "owner",
    adminPass: "test-password",
    runnerToken: "test-runner",
  });
  const orgops = createOrgOpsClient("http://engine", (async (url, init) =>
    engine.app.fetch(new Request(url, init))) as typeof fetch);
  product = createApp({ orgops, dbPath: join(dir, "product.sqlite") });
  const login = await product.app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "owner", password: "test-password" }),
  });
  owner = login.headers.getSetCookie()[0].split(";")[0];
});
afterEach(() => {
  product.store.close();
  engine.db.close();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("preserves OAuth cookies and redirects, creates an engine human, and grants ordinary product access", async () => {
  expect(
    await (await product.app.request("/api/auth/google/config")).json(),
  ).toMatchObject({ enabled: false });
  const save = () =>
    product.app.request("/api/auth/google/settings", {
      method: "PUT",
      headers: { cookie: owner, "content-type": "application/json" },
      body: JSON.stringify(settings),
    });
  expect((await save()).status).toBe(200);
  const start = await product.app.request(
    "/api/auth/google/start?returnTo=/admin/",
  );
  expect(start.status).toBe(302);
  const url = new URL(start.headers.get("location")!);
  expect(url.origin).toBe("https://accounts.google.com");
  const binding = start.headers.getSetCookie()[0];
  expect(binding).toMatch(/^orgops_google_state=/);
  expect(binding).toContain("HttpOnly");
  expect(binding).toContain("Secure");
  vi.spyOn(OAuth2Client.prototype, "getToken").mockResolvedValue({
    tokens: { id_token: "test-id-token" },
  } as any);
  vi.spyOn(OAuth2Client.prototype, "verifyIdToken").mockResolvedValue({
    getPayload: () => ({
      sub: "stable-subject",
      email: "colleague@example.com",
      email_verified: true,
      hd: "example.com",
      nonce: url.searchParams.get("nonce"),
    }),
  } as any);
  const callback = await product.app.request(
    `/api/auth/google/callback?state=${url.searchParams.get("state")}&code=test`,
    { headers: { cookie: `${binding.split(";")[0]}; ${owner}` } },
  );
  expect(callback.headers.get("location")).toBe("/admin/");
  expect(callback.headers.getSetCookie()).toHaveLength(2);
  expect(callback.headers.getSetCookie()[0]).toMatch(
    /^orgops_google_state=;.*Max-Age=0/,
  );
  const session = callback.headers
    .getSetCookie()
    .find((c) => c.startsWith("nest_session="))!;
  expect(session).toContain("Max-Age=28800");
  const headers = { cookie: session.split(";")[0] };
  expect(
    await (await product.app.request("/api/auth/me", { headers })).json(),
  ).toMatchObject({
    username: "colleague@example.com",
    mustChangePassword: false,
  });
  expect(
    (await product.app.request("/api/community/skills", { headers })).status,
  ).toBe(200);
  expect((await product.app.request("/api/projects", { headers })).status).toBe(
    200,
  );
  expect(
    await (
      await product.app.request("/api/branding/access", { headers })
    ).json(),
  ).toEqual({ canManage: false });
  expect(
    (await product.app.request("/api/auth/google/settings", { headers }))
      .status,
  ).toBe(403);
  expect(
    engine.db.prepare("SELECT COUNT(*) AS count FROM human_identities").get(),
  ).toEqual({ count: 1 });
  expect(
    engine.db.prepare("SELECT COUNT(*) AS count FROM team_memberships").get(),
  ).toEqual({ count: 1 });
  expect(
    product.store.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE name IN ('humans','human_identities','google_auth_settings')",
      )
      .all(),
  ).toEqual([]);
  expect(
    (await product.app.request("/api/auth/me", { headers: { cookie: owner } }))
      .status,
  ).toBe(401);
  await product.app.request("/api/auth/logout", { method: "POST", headers });
  expect((await product.app.request("/api/auth/me", { headers })).status).toBe(
    401,
  );
});

it("does not allow anonymous or runner access to sign-in configuration", async () => {
  expect((await product.app.request("/api/auth/google/settings")).status).toBe(
    401,
  );
  expect(
    (
      await product.app.request("/api/auth/google/settings", {
        headers: { "x-nest-runner-token": "test-runner" },
      })
    ).status,
  ).toBe(403);
  const result = await product.app.request("/api/auth/google/settings", {
    headers: { cookie: owner },
  });
  expect(await result.text()).not.toContain("test-secret");
  const response = await product.app.request(
    "/api/auth/google/callback?state=invalid&code=invalid",
  );
  expect(response.headers.get("location")).toBe("/?authError=google_state");
  expect(response.headers.get("cache-control")).toBe("no-store");
});
