import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "@nest/db";
import { DEFAULT_BRANDING } from "@nest/schemas";
import { createApp } from "./app";

const custom = { displayName: "Acme", logoUrl: "https://example.com/logo.svg", primaryColor: "#350950", accentColor: "#a65bd4", backgroundColor: "#f8f5ff" };
async function fixture(onTestFinished: (fn: () => void) => void) {
  const root = mkdtempSync(join(tmpdir(), "nest-instance-branding-"));
  const db = openDb(":memory:");
  onTestFinished(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const config = { db, dataDir: root, adminUser: "owner", adminPass: "owner-password", runnerToken: "test-runner" };
  const { app } = createApp(config);
  const login = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'owner-password' }) });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  return { app, config, db, headers: { cookie, 'content-type': 'application/json' } };
}

describe('instance branding', () => {
  it('exposes defaults before login, saves owner changes, and persists across app restarts', async ({ onTestFinished }) => {
    const { app, config, headers, db } = await fixture(onTestFinished);
    const initial = await app.request('/api/branding');
    expect(initial.status).toBe(200); expect(await initial.json()).toEqual(DEFAULT_BRANDING);
    expect(initial.headers.get('cache-control')).toBe('no-store');
    expect(await (await app.request('/api/branding/access', { headers })).json()).toEqual({ canManage: true });
    const saved = await app.request('/api/branding', { method: 'PUT', headers, body: JSON.stringify(custom) });
    expect(saved.status).toBe(200);
    expect(await (await createApp(config).app.request('/api/branding')).json()).toEqual(custom);
    expect(db.prepare("SELECT COUNT(*) AS count FROM events WHERE type = 'audit.branding.updated'").get()).toEqual({ count: 1 });
    // Restoring defaults is also persisted, rather than merely changing local state.
    expect((await app.request('/api/branding', { method: 'PUT', headers, body: JSON.stringify(DEFAULT_BRANDING) })).status).toBe(200);
    expect(await (await app.request('/api/branding')).json()).toEqual(DEFAULT_BRANDING);
  });
  it('rejects unauthenticated users, runner credentials and other humans', async ({ onTestFinished }) => {
    const { app, headers } = await fixture(onTestFinished);
    const request = { method: 'PUT', body: JSON.stringify(custom) };
    expect((await app.request('/api/branding', request)).status).toBe(401);
    expect((await app.request('/api/branding', { ...request, headers: { 'x-nest-runner-token': 'test-runner' } })).status).toBe(403);
    await app.request('/api/humans/invite', { method: 'POST', headers, body: JSON.stringify({ username: 'member', tempPassword: 'member-password' }) });
    const login = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'member', password: 'member-password' }) });
    expect(login.status).toBe(200);
    const memberHeaders = { cookie: login.headers.get('set-cookie')!.split(';')[0], 'content-type': 'application/json' };
    await app.request('/api/auth/profile', { method: 'PATCH', headers: memberHeaders, body: JSON.stringify({ newPassword: 'updated-member-password', currentPassword: 'member-password' }) });
    expect((await app.request('/api/branding', { ...request, headers: memberHeaders })).status).toBe(403);
    expect(await (await app.request('/api/branding/access', { headers: memberHeaders })).json()).toEqual({ canManage: false });
  });
  it('validates image sources, colors, name and request size without altering saved settings', async ({ onTestFinished }) => {
    const { app, headers } = await fixture(onTestFinished);
    for (const patch of [{ logoUrl: 'javascript:alert(1)' }, { logoUrl: '//evil.test/logo.svg' }, { logoUrl: 'data:text/html,test' }, { logoUrl: 'data:image/svg+xml;base64,PHN2Zz4=' }, { primaryColor: 'red;display:none' }, { displayName: ' ' }]) {
      expect((await app.request('/api/branding', { method: 'PUT', headers, body: JSON.stringify({ ...custom, ...patch }) })).status).toBe(400);
    }
    expect((await app.request('/api/branding', { method: 'PUT', headers, body: 'x'.repeat(360_001) })).status).toBe(413);
    expect(await (await app.request('/api/branding')).json()).toEqual(DEFAULT_BRANDING);
  });
});
