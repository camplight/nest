import { chromium } from "playwright";
import tailwindConfig from "../../apps/admin-ui/tailwind.config";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { OAuth2Client } from "google-auth-library";
import { createApp as createEngine } from "../../vendor/orgops/apps/api/src/app";
import { createOrgOpsClient } from "../../packages/orgops-client/src/index";
import { createApp } from "../../apps/api/src/app";

// Isolated engine/product databases. Only the external Google SDK boundary is simulated.
const dir = mkdtempSync(join(tmpdir(), "nest-google-browser-"));
const screenshots = mkdtempSync(join(tmpdir(), "nest-google-screenshots-"));
process.env.ORGOPS_GOOGLE_CLIENT_ID = "test.apps.googleusercontent.com";
process.env.ORGOPS_GOOGLE_CLIENT_SECRET = "test-secret";
process.env.ORGOPS_GOOGLE_REDIRECT_URI =
  "http://127.0.0.1:5300/api/auth/google/callback";
const engine = createEngine({
  dbPath: join(dir, "engine.sqlite"),
  dataDir: dir,
  projectRoot: dir,
  adminUser: "owner",
  adminPass: "test-password",
});
const product = createApp({
  orgops: createOrgOpsClient("http://engine", (async (url, init) =>
    engine.app.fetch(new Request(url, init))) as typeof fetch),
  dbPath: join(dir, "product.sqlite"),
});
const apiRequire = createRequire(join(process.cwd(), "apps/api/package.json"));
const { serve } = apiRequire("@hono/node-server");
const backend = serve({
  fetch: product.app.fetch,
  hostname: "127.0.0.1",
  port: 0,
});
await once(backend, "listening");
const backendUrl = `http://127.0.0.1:${backend.address().port}`;
const servers: any[] = [];
const originalGet = OAuth2Client.prototype.getToken,
  originalVerify = OAuth2Client.prototype.verifyIdToken;
let nonce = "";
OAuth2Client.prototype.getToken = (async () => ({
  tokens: { id_token: "simulated-token" },
})) as any;
OAuth2Client.prototype.verifyIdToken = (async () => ({
  getPayload: () => ({
    sub: "test-subject",
    email: "colleague@example.com",
    email_verified: true,
    hd: "example.com",
    nonce,
  }),
})) as any;
try {
  for (const [app, port] of [
    ["user-ui", 5300],
    ["admin-ui", 5301],
  ] as const) {
    const req = createRequire(join(process.cwd(), `apps/${app}/package.json`));
    const { createServer } = await import(req.resolve("vite"));
    const css =
      app === "admin-ui"
        ? {
            postcss: {
              plugins: [
                req("tailwindcss")({
                  ...tailwindConfig,
                  content: [
                    join(process.cwd(), "apps/admin-ui/index.html"),
                    join(process.cwd(), "apps/admin-ui/src/**/*.{ts,tsx}"),
                  ],
                }),
                req("autoprefixer")(),
              ],
            },
          }
        : undefined;
    const server = await createServer({
      css,
      root: join(process.cwd(), `apps/${app}`),
      server: {
        host: "127.0.0.1",
        port,
        strictPort: true,
        proxy: { "/api": backendUrl },
      },
    });
    await server.listen();
    servers.push(server);
  }
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1100 },
    });
    page.setDefaultTimeout(15000);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.routeWebSocket("**/ws", (socket) => socket.close());
    await page.goto("http://127.0.0.1:5300/");
    await page.getByRole("button", { name: "Continue", exact: true }).waitFor();
    assert.equal(
      await page.getByRole("link", { name: "Continue with Google" }).count(),
      0,
    );
    const login = await product.app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "test-password" }),
    });
    const owner = login.headers.getSetCookie()[0].split(";")[0];
    await page
      .context()
      .addCookies([
        {
          name: "nest_session",
          value: owner.slice("nest_session=".length),
          url: "http://127.0.0.1:5301",
          httpOnly: true,
        },
      ]);
    await page.goto("http://127.0.0.1:5301/");
    await page
      .getByRole("navigation", { name: "Administration" })
      .getByRole("button", { name: "Sign-in", exact: true })
      .click();
    await page.getByLabel("Allowed Workspace domain").fill("example.com");
    await page.getByLabel("Default team").fill("Example team");
    await page.getByLabel("Enable Google sign-in").check();
    await page.getByRole("button", { name: "Save sign-in settings" }).click();
    await page.getByText("Sign-in settings saved.", { exact: false }).waitFor();
    await page.screenshot({
      path: join(screenshots, "google-settings-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.screenshot({
      path: join(screenshots, "google-settings-mobile.png"),
      fullPage: true,
    });
    await page.context().clearCookies();
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.goto("http://127.0.0.1:5301/");
    const adminButton = page.getByRole("link", {
      name: "Continue with Google",
    });
    await adminButton.waitFor();
    assert(
      (await adminButton.getAttribute("href"))?.includes(
        "returnTo=%2Fadmin%2F",
      ),
    );
    await page.screenshot({
      path: join(screenshots, "google-admin-login-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({path: join(screenshots, "google-admin-login-mobile.png"), fullPage: true});
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.goto("http://127.0.0.1:5300/");
    await page.getByRole("link", { name: "Continue with Google" }).waitFor();
    await page.screenshot({
      path: join(screenshots, "google-login-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.screenshot({
      path: join(screenshots, "google-login-mobile.png"),
      fullPage: true,
    });
    await page.route("**/api/auth/google/start?**", async (route) => {
      const start = await route.fetch({ maxRedirects: 0 });
      assert.equal(start.status(), 302);
      const url = new URL(start.headers().location);
      nonce = url.searchParams.get("nonce")!;
      assert.equal(url.origin, "https://accounts.google.com");
      await route.fulfill({
        response: start,
        headers: {
          ...start.headers(),
          location: `http://127.0.0.1:5300/api/auth/google/callback?state=${url.searchParams.get("state")}&code=test-code`,
        },
      });
    });
    await page.getByRole("link", { name: "Continue with Google" }).click();
    await page
      .getByRole("heading", { name: "Dashboard", exact: true })
      .waitFor();
    assert.equal(
      await page.evaluate(async () => {
        const r = await fetch("/api/auth/me");
        return (await r.json()).username;
      }),
      "colleague@example.com",
    );
    assert.equal(
      await page.evaluate(
        async () => (await fetch("/api/auth/google/settings")).status,
      ),
      403,
    );
    await page.context().clearCookies();
    await page.goto("http://127.0.0.1:5300/?authError=google_domain");
    await page
      .getByRole("alert")
      .filter({ hasText: "Google Workspace account" })
      .waitFor();
    assert.deepEqual(errors, []);
    console.log(
      `PASS: disabled/enabled login, owner settings, desktop/mobile layouts, admin return URL, simulated Google redirect through real engine/gateway, JIT account and nonowner denial. Screenshots: ${screenshots}`,
    );
  } finally {
    await browser.close();
  }
} finally {
  OAuth2Client.prototype.getToken = originalGet;
  OAuth2Client.prototype.verifyIdToken = originalVerify;
  for (const server of servers) await server.close();
  await new Promise<void>((resolve) => backend.close(() => resolve()));
  product.store.close();
  engine.db.close();
  rmSync(dir, { recursive: true, force: true });
}
