import { chromium } from "playwright";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { createApp as createEngine } from "../../vendor/orgops/apps/api/src/app";
import { createOrgOpsClient } from "../../packages/orgops-client/src/index";
import { createApp } from "../../apps/api/src/app";
const dir = mkdtempSync(join(tmpdir(), "nest-targeted-browser-")),
  screenshots = mkdtempSync(join(tmpdir(), "nest-targeted-screenshots-"));
const engine = createEngine({
  dbPath: join(dir, "engine.sqlite"),
  projectRoot: dir,
  dataDir: dir,
  adminUser: "demo-alice",
  adminPass: "password",
  runnerToken: "runner",
});
let loseSend = false;
const client = createOrgOpsClient("http://engine", async (url, init) => {
  const r = await engine.app.fetch(new Request(url, init));
  if (
    loseSend &&
    new URL(String(url)).pathname === "/api/events" &&
    init?.method === "POST"
  ) {
    loseSend = false;
    throw Error("Lost test response");
  }
  return r;
});
const product = createApp({
  orgops: client,
  dbPath: join(dir, "product.sqlite"),
  connections: null,
});
const req = createRequire(join(process.cwd(), "apps/user-ui/package.json"));
const server = spawn(
  process.execPath,
  [
    join(dirname(req.resolve("vite/package.json")), "bin/vite.js"),
    "--host",
    "127.0.0.1",
    "--port",
    "5310",
    "--strictPort",
  ],
  { cwd: join(process.cwd(), "apps/user-ui"), stdio: "pipe" },
);
const base = "http://127.0.0.1:5310";
try {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Vite timeout")), 20000);
    server.stdout.on("data", (c) => {
      if (c.toString().includes("5310")) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.on("error", reject);
  });
  const post = (path: string, body: unknown, headers: Record<string, string>) =>
    product.app.request(path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  const login = await post(
    "/api/auth/login",
    { username: "demo-alice", password: "password" },
    { "content-type": "application/json" },
  );
  const cookie = login.headers.getSetCookie()[0].split(";")[0],
    headers = { cookie, "content-type": "application/json" };
  await post(
    "/api/humans/invite",
    { username: "demo-bob", tempPassword: "password" },
    headers,
  );
  engine.db
    .prepare(
      "UPDATE humans SET must_change_password=0 WHERE username='demo-bob'",
    )
    .run();
  const bobLogin = await post(
    "/api/auth/login",
    { username: "demo-bob", password: "password" },
    { "content-type": "application/json" },
  );
  const bobCookie = bobLogin.headers.getSetCookie()[0].split(";")[0];
  for (const name of ["Puff", "Moss", "Outsider"])
    assert.equal(
      (
        await post(
          "/api/agents",
          {
            name,
            modelId: "openrouter:test-only",
            workspacePath: join(dir, name),
          },
          headers,
        )
      ).status,
      201,
    );
  await product.app.request("/api/branding", {
    method: "PUT",
    headers,
    body: JSON.stringify({
      displayName: "Camplight",
      logoUrl: "/brand/camplight-logo-white.svg",
      primaryColor: "#350956",
      accentColor: "#ff7557",
      backgroundColor: "#f8f4ff",
    }),
  });
  const ch = await (
    await post(
      "/api/channels",
      { name: "Demo product planning", visibility: "PRIVATE" },
      headers,
    )
  ).json();
  for (const [subscriberType, subscriberId] of [
    ["AGENT", "Puff"],
    ["AGENT", "Moss"],
    ["HUMAN", "demo-bob"],
  ])
    assert(
      (
        await post(
          "/api/channels/" + ch.id + "/subscribe",
          { subscriberType, subscriberId },
          headers,
        )
      ).ok,
    );
  const browser = await chromium.launch();
  try {
    async function session(cookie: string) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      });
      await context.addCookies([
        {
          name: "nest_session",
          value: cookie.slice("nest_session=".length),
          url: base,
          httpOnly: true,
        },
      ]);
      await context.route("**/api/**", async (route) => {
        const request = route.request(),
          u = new URL(request.url());
        const r = await product.app.request(u.pathname + u.search, {
          method: request.method(),
          headers: request.headers(),
          ...(request.postDataBuffer()
            ? { body: new Uint8Array(request.postDataBuffer()!) }
            : {}),
        });
        await route.fulfill({
          status: r.status,
          headers: Object.fromEntries(r.headers),
          body: Buffer.from(await r.arrayBuffer()),
        });
      });
      await context.routeWebSocket("**/ws", (socket) => socket.close());
      return context;
    }
    const alice = await session(cookie),
      bob = await session(bobCookie),
      page = await alice.newPage();
    page.setDefaultTimeout(15000);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(base + "/?channel=" + ch.id);
    const input = page.getByRole("textbox", { name: "Message", exact: true }),
      popup = page.getByRole("listbox", { name: "Mention people and agents" });
    await input.fill("@Outsider");
    assert.equal(
      await popup.getByRole("option").getAttribute("aria-disabled"),
      "true",
    );
    await input.press("Enter");
    assert.equal(await input.inputValue(), "@Outsider");
    await input.press("Escape");
    await input.fill("@pu");
    await input.press("Enter");
    await input.press("End");
    await input.press(" ");
    await input.press("@");
    await input.press("d");
    await input.press("e");
    await popup.getByRole("option").filter({ hasText: "demo-bob" }).click();
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(resolve)),
    );
    await input.press("End");
    await input.press(" ");
    await input.press("r");
    await input.press("e");
    await input.press("v");
    await input.press("i");
    await input.press("e");
    await input.press("w");
    await page
      .getByText("Only the selected agent receives this request.", {
        exact: true,
      })
      .waitFor();
    await page.screenshot({
      path: join(screenshots, "delivery-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.screenshot({
      path: join(screenshots, "delivery-mobile.png"),
      fullPage: true,
    });
    loseSend = true;
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "uncertain" }).waitFor();
    assert((await input.inputValue()).includes("@Puff"));
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLTextAreaElement>(
          'textarea[aria-label="Message"]',
        )?.value === "",
    );
    const events = await (
      await product.app.request(
        "/api/events?channelId=" + ch.id + "&type=message.created",
        { headers },
      )
    ).json();
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.targetAgentName, "Puff");
    await page.getByText("To @Puff", { exact: true }).waitFor();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await input.fill("@pu");
    await input.press("Enter");
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(resolve)),
    );
    await input.press("End");
    await input.press("@");
    await input.press("m");
    await popup.getByRole("option").filter({ hasText: "Moss" }).click();
    await page
      .getByRole("alert")
      .filter({ hasText: "Choose one agent" })
      .waitFor();
    assert(
      await page
        .getByRole("button", { name: "Send", exact: true })
        .isDisabled(),
    );
    await page
      .getByRole("button", { name: "Remove mention @Moss", exact: true })
      .click();
    assert(
      await page.getByRole("button", { name: "Send", exact: true }).isEnabled(),
    );
    await input.fill("Edited @Puf");
    assert.equal(await page.getByLabel("Message recipients").count(), 0);
    // Upload metadata must not leak browser-local attachment fields into the strict send API.
    await input.fill("Attached notes");
    await page.locator('input[type="file"]').setInputFiles({
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Demo test attachment"),
    });
    await page.getByText(/^Ready/).waitFor();
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLTextAreaElement>(
          'textarea[aria-label="Message"]',
        )?.value === "",
    );
    // Mention links must also work outside the latest message page.
    for(let i=0;i<60;i++)assert((await post('/api/events',{type:'message.created',channelId:ch.id,source:'human:demo-alice',payload:{text:'Later demo message '+i}},headers)).ok);
    const receiver = await bob.newPage();
    await receiver.goto(base + "/");
    await receiver
      .getByRole("button", { name: "Mentions", exact: true })
      .click();
    await receiver
      .getByText("demo-alice mentioned you", { exact: true })
      .waitFor();
    await receiver.keyboard.press("Escape");
    assert.equal(
      await receiver.getByRole("dialog", { name: "Your mentions" }).count(),
      0,
    );
    assert(
      await receiver
        .getByRole("button", { name: "Mentions", exact: true })
        .evaluate((node) => node === document.activeElement),
    );
    await receiver
      .getByRole("button", { name: "Mentions", exact: true })
      .press("Enter");
    await receiver.getByRole("dialog", { name: "Your mentions" }).waitFor();
    await receiver.screenshot({
      path: join(screenshots, "inbox-desktop.png"),
      fullPage: true,
    });
    await receiver.setViewportSize({ width: 390, height: 844 });
    await receiver.screenshot({
      path: join(screenshots, "inbox-mobile.png"),
      fullPage: true,
    });
    assert(
      await receiver.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await receiver
      .getByRole("button")
      .filter({ hasText: "demo-alice mentioned you" })
      .click();
    await receiver
      .locator("#message-" + events[0].id + ".message-highlight")
      .waitFor();
    assert.equal(
      new URL(receiver.url()).searchParams.get("message"),
      events[0].id,
    );
    await receiver.reload();
    await receiver
      .locator("#message-" + events[0].id + ".message-highlight")
      .waitFor();
    await receiver.waitForFunction((id)=>{const node=document.getElementById('message-'+id);if(!node)return false;const r=node.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;},events[0].id);
    await receiver.getByRole("button", { name: "Menu", exact: true }).click();
    await receiver
      .getByRole("button", { name: "Mentions", exact: true })
      .click();
    await receiver
      .getByRole("button")
      .filter({ hasText: "demo-alice mentioned you" })
      .waitFor();
    assert.equal(await receiver.getByLabel("Unread mentions").count(), 0);
    assert.deepEqual(errors, []);
    console.log(
      "PASS: real-engine targeted delivery, participant validation, recoverable retry, multiple-agent prevention, selected-name edits, attachments, human inbox, read state, message links and mobile. Screenshots: " +
        screenshots,
    );
  } finally {
    await browser.close();
  }
} finally {
  server.kill("SIGTERM");
  product.store.close();
  engine.db.close();
  rmSync(dir, { recursive: true, force: true });
}
