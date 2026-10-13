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

const dir = mkdtempSync(join(tmpdir(), "nest-request-browser-")),
  screenshots = mkdtempSync(join(tmpdir(), "nest-request-screenshots-"));
const engine = createEngine({
  projectRoot: dir,
  dataDir: dir,
  dbPath: join(dir, "engine.sqlite"),
  adminUser: "demo-naska",
  adminPass: "password",
  runnerToken: "runner",
});
const product = createApp({
  connections: null,
  connectionEngineToken: "runner",
  orgops: createOrgOpsClient("http://engine", async (url, init) =>
    engine.app.fetch(new Request(url, init)),
  ),
  dbPath: join(dir, "product.sqlite"),
  personalAgent: {
    modelId: "demo-model",
    runnerId: "runner",
    workspaceRoot: join(dir, "personal"),
  },
});
const req = createRequire(join(process.cwd(), "apps/user-ui/package.json"));
const server = spawn(
  process.execPath,
  [
    join(dirname(req.resolve("vite/package.json")), "bin/vite.js"),
    "--host",
    "127.0.0.1",
    "--port",
    "5311",
    "--strictPort",
  ],
  { cwd: join(process.cwd(), "apps/user-ui"), stdio: "pipe" },
);
const base = "http://127.0.0.1:5311";
const post = (path: string, headers: Record<string, string>, body: unknown) =>
  product.app.request(path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Vite timeout")), 20000);
    server.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("5311")) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.on("error", reject);
  });
  async function login(username: string) {
    const r = await post(
      "/api/auth/login",
      { "content-type": "application/json" },
      { username, password: "password" },
    );
    assert.equal(r.status, 200);
    return {
      cookie: r.headers.getSetCookie()[0].split(";")[0],
      "content-type": "application/json",
    };
  }
  const owner = await login("demo-naska");
  assert(
    (
      await post("/api/humans/invite", owner, {
        username: "demo-vitaliy",
        tempPassword: "password",
      })
    ).ok,
  );
  engine.db
    .prepare(
      "UPDATE humans SET must_change_password=0 WHERE username='demo-vitaliy'",
    )
    .run();
  const guest = await login("demo-vitaliy");
  await post("/api/models", owner, {
    id: "demo-model",
    provider: "openrouter",
    modelName: "test-only",
    enabled: true,
  });
  await post(
    "/api/runners/register",
    { "content-type": "application/json", "x-nest-runner-token": "runner" },
    { existingRunnerId: "runner", displayName: "Demo runner" },
  );
  const setup = await post("/api/onboarding/agent", owner, {
    name: "PuffNaskaDemo",
    character: "puff",
    brief: "Demo private assistant instructions",
  });
  assert.equal(setup.status, 200);
  const privateChannel = (await setup.json()).channelId;
  const chat = (
    await (
      await post("/api/channels", guest, {
        name: "Demo request workspace",
        visibility: "PRIVATE",
      })
    ).json()
  ).id;
  browser = await chromium.launch();
  let loseCreate = true;
  async function page(headers: Record<string, string>) {
    const context = await browser!.newContext({
      viewport: { width: 1440, height: 1100 },
      reducedMotion: "reduce",
    });
    await context.addCookies([
      {
        name: "nest_session",
        value: headers.cookie.slice("nest_session=".length),
        url: base,
      },
    ]);
    const page = await context.newPage();
    await page.routeWebSocket("**/ws", (socket) => socket.close());
    await page.route("**/api/**", async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      const response = await product.app.request(url.pathname + url.search, {
        method: request.method(),
        headers: request.headers(),
        ...(request.postDataBuffer()
          ? { body: request.postDataBuffer()! }
          : {}),
      });
      if (
        loseCreate &&
        url.pathname === "/api/agent-requests" &&
        request.method() === "POST" &&
        response.ok
      ) {
        loseCreate = false;
        await route.fulfill({
          status: 502,
          json: {
            error: "Test: saved request response lost. Retry unchanged.",
          },
        });
        return;
      }
      await route.fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: Buffer.from(await response.arrayBuffer()),
      });
    });
    return page;
  }
  const naska = await page(owner),
    vitaliy = await page(guest);
  await naska.goto(base + "/?view=agents&agent=PuffNaskaDemo");
  await naska
    .getByRole("checkbox", {
      name: "Let teammates request work from PuffNaskaDemo",
    })
    .check();
  await naska
    .getByLabel("What can teammates ask for?")
    .fill("Demo: launch-board updates and preparing Trello cards.");
  await naska
    .getByRole("button", { name: "Save request settings", exact: true })
    .click();
  await naska
    .getByRole("status")
    .filter({ hasText: "Request settings saved." })
    .waitFor();
  await naska
    .getByRole("heading", { name: "Teammate requests", exact: true })
    .evaluate((node) => node.scrollIntoView({ block: "start" }));
  await naska.screenshot({
    path: join(screenshots, "sharing-desktop.png"),
    fullPage: true,
  });
  await naska.setViewportSize({ width: 390, height: 844 });
  await naska
    .getByRole("heading", { name: "Teammate requests", exact: true })
    .evaluate((node) => node.scrollIntoView({ block: "start" }));
  await naska.screenshot({
    path: join(screenshots, "sharing-mobile.png"),
    fullPage: true,
  });
  await naska.setViewportSize({ width: 1440, height: 1100 });

  await vitaliy.goto(base + "/?view=agents");
  await vitaliy
    .getByRole("button", { name: "Ask PuffNaskaDemo", exact: true })
    .waitFor();
  await vitaliy.screenshot({
    path: join(screenshots, "directory-desktop.png"),
    fullPage: true,
  });
  await vitaliy.setViewportSize({ width: 390, height: 844 });
  await vitaliy
    .getByRole("heading", { name: "Personal assistants", exact: true })
    .evaluate((node) => node.scrollIntoView({ block: "start" }));
  assert(
    await vitaliy.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await vitaliy.screenshot({
    path: join(screenshots, "directory-mobile.png"),
    fullPage: true,
  });
  await vitaliy.setViewportSize({ width: 1440, height: 1100 });

  await vitaliy
    .getByRole("button", { name: "Ask PuffNaskaDemo", exact: true })
    .click();
  assert.equal(
    new URL(vitaliy.url()).searchParams.get("assistant"),
    "PuffNaskaDemo",
  );
  await vitaliy
    .getByRole("heading", { name: "Ask PuffNaskaDemo", exact: true })
    .waitFor();
  await vitaliy
    .getByRole("navigation", { name: "Agent views" })
    .getByRole("button", { name: "All agents", exact: true })
    .click();
  await vitaliy.goto(base + "/?channel=" + chat);
  const composer = vitaliy.getByRole("textbox", {
    name: "Message",
    exact: true,
  });
  await composer.fill("Summarize our demo launch board. @pfnd");
  const suggestion = vitaliy
    .getByRole("option")
    .filter({ hasText: "PuffNaskaDemo" });
  await suggestion.waitFor();
  assert.equal(await suggestion.getAttribute("aria-disabled"), "false");
  await vitaliy.screenshot({
    path: join(screenshots, "mention-desktop.png"),
    fullPage: true,
  });
  await vitaliy.setViewportSize({ width: 390, height: 844 });
  assert(
    await vitaliy.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await vitaliy.screenshot({
    path: join(screenshots, "mention-mobile.png"),
    fullPage: true,
  });
  await vitaliy.setViewportSize({ width: 1440, height: 1100 });

  await composer.press("Enter");
  await vitaliy
    .getByRole("heading", { name: "Ask PuffNaskaDemo", exact: true })
    .waitFor();
  assert.equal(new URL(vitaliy.url()).searchParams.get("tab"), "requests");
  assert.equal(
    await vitaliy.getByLabel("What would you like help with?").inputValue(),
    "Summarize our demo launch board.",
  );
  await vitaliy
    .getByLabel("Request title", { exact: true })
    .fill("Demo launch status");
  await vitaliy
    .getByRole("button", { name: "Send request", exact: true })
    .click();
  await vitaliy
    .getByRole("alert")
    .filter({ hasText: "saved request response lost" })
    .waitFor();
  await vitaliy.reload();
  await vitaliy
    .getByRole("button", { name: "Retry request", exact: true })
    .waitFor();
  assert.equal(
    await vitaliy.getByLabel("Request title", { exact: true }).inputValue(),
    "Demo launch status",
  );
  assert(
    await vitaliy.getByLabel("Request title", { exact: true }).isDisabled(),
  );
  await vitaliy
    .getByRole("button", { name: "Retry request", exact: true })
    .click();
  await vitaliy
    .getByRole("heading", { name: "Demo launch status", exact: true })
    .waitFor();
  const requestId = new URL(vitaliy.url()).searchParams.get("request");
  assert(requestId);
  const count = product.store.db
    .prepare("SELECT COUNT(*) AS n FROM product_agent_requests")
    .get() as { n: number };
  assert.equal(count.n, 1);
  assert.equal(
    (
      await (
        await product.app.request(
          `/api/events?channelId=${privateChannel}&type=message.created`,
          { headers: owner },
        )
      ).json()
    ).length,
    0,
  );
  assert.equal(
    (
      await (
        await product.app.request(
          `/api/events?channelId=${chat}&type=message.created`,
          { headers: guest },
        )
      ).json()
    ).length,
    0,
  );
  await vitaliy.screenshot({
    path: join(screenshots, "pending-desktop.png"),
    fullPage: true,
  });
  await vitaliy.setViewportSize({ width: 390, height: 844 });
  assert(
    await vitaliy.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await vitaliy.screenshot({
    path: join(screenshots, "pending-mobile.png"),
    fullPage: true,
  });
  await vitaliy.setViewportSize({ width: 1440, height: 1100 });

  await naska.goto(base + "/?view=agents&tab=requests");
  await naska
    .getByRole("button", { name: "Demo launch status", exact: true })
    .click();
  assert.equal(new URL(naska.url()).searchParams.get("request"), requestId);
  await naska
    .getByRole("button", { name: "Approve and ask PuffNaskaDemo", exact: true })
    .waitFor();
  await naska.screenshot({
    path: join(screenshots, "approval-desktop.png"),
    fullPage: true,
  });
  await naska.setViewportSize({ width: 390, height: 844 });
  assert(
    await naska.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await naska.getByRole("heading",{name:"Approve the work",exact:true}).evaluate(node=>node.scrollIntoView({block:"start"}));
  await naska.screenshot({
    path: join(screenshots, "approval-mobile.png"),
    fullPage: true,
  });
  await naska.setViewportSize({ width: 1440, height: 1100 });
  await naska
    .getByRole("button", { name: "Approve and ask PuffNaskaDemo", exact: true })
    .click();
  await naska
    .getByRole("heading", { name: "Review and share a reply", exact: true })
    .waitFor();
  const privateEvents = await (
    await product.app.request(
      `/api/events?channelId=${privateChannel}&type=message.created`,
      { headers: owner },
    )
  ).json();
  assert.equal(privateEvents.length, 1);
  assert.equal(privateEvents[0].source, "human:demo-naska");
  assert.equal(privateEvents[0].payload.targetAgentName, "PuffNaskaDemo");
  const result = await engine.app.request("/api/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-orgops-runner-token": "runner",
    },
    body: JSON.stringify({
      type: "message.created",
      source: "agent:PuffNaskaDemo",
      channelId: privateChannel,
      payload: {
        text: "DEMO PRIVATE-ONLY-CONTENT. Launch is green; next milestone Friday.",
      },
    }),
  });
  assert.equal(result.status, 201);
  const candidates = await product.app.request(
    `/api/agent-requests/${requestId}/responses`,
    { headers: owner },
  );
  assert.equal(candidates.status, 200);
  const candidateRows = await candidates.json();
  assert.equal(candidateRows.length, 1, JSON.stringify(candidateRows));
  await naska
    .getByRole("button", { name: "Refresh agent responses", exact: true })
    .click();
  const select = naska.getByLabel("Private agent response", { exact: true });
  try {
    await select
      .locator("option")
      .filter({ hasText: "DEMO PRIVATE-ONLY-CONTENT" })
      .waitFor({ state: "attached", timeout: 10000 });
  } catch (error) {
    console.log(
      "Synthetic owner response UI:",
      await naska.locator("body").innerText(),
    );
    await naska.screenshot({
      path: join(screenshots, "response-failure.png"),
      fullPage: true,
    });
    throw error;
  }
  await select.selectOption((await result.json()).id);
  await naska
    .getByLabel("Reply to share", { exact: true })
    .fill("Demo launch is on track. Next milestone: Friday.");
  await naska
    .getByRole("heading", { name: "Review and share a reply", exact: true })
    .evaluate((node) => node.scrollIntoView({ block: "start" }));
  await naska.screenshot({
    path: join(screenshots, "review-desktop.png"),
    fullPage: true,
  });
  await naska.setViewportSize({ width: 390, height: 844 });
  await naska
    .getByRole("heading", { name: "Review and share a reply", exact: true })
    .evaluate((node) => node.scrollIntoView({ block: "start" }));
  assert(
    await naska.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await naska.screenshot({
    path: join(screenshots, "review-mobile.png"),
    fullPage: true,
  });
  await naska.setViewportSize({ width: 1440, height: 1100 });
  await vitaliy.reload();
  assert(
    !(await vitaliy.locator("body").innerText()).includes(
      "PRIVATE-ONLY-CONTENT",
    ),
  );
  await naska
    .getByRole("button", { name: "Share approved reply", exact: true })
    .click();
  await naska
    .getByRole("heading", { name: "Approved reply", exact: true })
    .waitFor();
  await vitaliy
    .getByText("Demo launch is on track. Next milestone: Friday.", {
      exact: true,
    })
    .waitFor();
  assert(
    !(await vitaliy.locator("body").innerText()).includes(
      "PRIVATE-ONLY-CONTENT",
    ),
  );
  await vitaliy.screenshot({
    path: join(screenshots, "reply-desktop.png"),
    fullPage: true,
  });
  await vitaliy.setViewportSize({ width: 390, height: 844 });
  assert(
    await vitaliy.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await vitaliy.screenshot({
    path: join(screenshots, "reply-mobile.png"),
    fullPage: true,
  });
  await vitaliy.reload();
  await vitaliy
    .getByRole("heading", { name: "Approved reply", exact: true })
    .waitFor();
  assert.equal(new URL(vitaliy.url()).searchParams.get("request"), requestId);
  await vitaliy
    .getByRole("button", { name: "← Requests", exact: true })
    .click();


  await vitaliy.getByRole("button", { name: "Outgoing", exact: true }).click();
  await vitaliy
    .getByRole("button", { name: "Demo launch status", exact: true })
    .waitFor();
  await vitaliy.goBack();
  await vitaliy
    .getByRole("heading", { name: "Approved reply", exact: true })
    .waitFor();

  // Pagination must be scoped by direction and survive an automatic inbox poll.
  for (let i = 0; i < 51; i++) {
    const created = await post("/api/agent-requests", guest, {
      id: crypto.randomUUID(),
      agentName: "PuffNaskaDemo",
      title: `Older-page fixture ${i}`,
      brief: "Demo pagination request",
    });
    assert.equal(created.status, 201);
  }
  await vitaliy
    .getByRole("button", { name: "← Requests", exact: true })
    .click();
  await vitaliy.getByRole("button", { name: "Outgoing", exact: true }).click();
  await vitaliy
    .getByRole("button", { name: "Load older requests", exact: true })
    .click();
  await vitaliy
    .getByRole("button", { name: "Demo launch status", exact: true })
    .waitFor();
  // Wait on actual poll traffic, not a timer, then verify the loaded older row remains.
  await vitaliy.waitForResponse(
    (response) =>
      response.url().includes("/api/agent-requests?direction=outgoing") &&
      !response.url().includes("offset=") &&
      response.status() === 200,
  );
  await vitaliy
    .getByRole("button", { name: "Demo launch status", exact: true })
    .waitFor();
  console.log(
    `PASS: opt-in assistant profiles, fuzzy @ request handoff, owner-only approval, private dispatch, lost-response/reload recovery, edited reply sharing, requester isolation, inbox, history and responsive UI. Real engine; scripted agent reply; no live LLM or external account. Screenshots: ${screenshots}`,
  );
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  product.store.close();
  engine.db.close();
  rmSync(dir, { recursive: true, force: true });
}
