import { chromium } from "playwright";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { createApp as createEngine } from "../../vendor/orgops/apps/api/src/app";
import { createComposioProvider } from "../../apps/api/src/integrations/composio";
import { createOrgOpsClient } from "../../packages/orgops-client/src/index";
import { createApp } from "../../apps/api/src/app";

const dir = mkdtempSync(join(tmpdir(), "nest-personal-browser-"));
const screenshots = mkdtempSync(join(tmpdir(), "nest-personal-screenshots-"));
const previousRoot = process.env.ORGOPS_PROJECT_ROOT;
process.env.ORGOPS_PROJECT_ROOT = dir;
let connectionActive = false;
let externalUserId = "";
const composio = {
      apiKey: "test-only-key",
      instanceId: "test",
      callbackUrl: "https://nest.example/onboarding",
      authConfigs: { trello: "test-config" },
      fetch: async (url: URL, init?: RequestInit) => {
        const path = url.pathname.replace("/api/v3.1", "");
        if (path === "/connected_accounts/link") {
          externalUserId = JSON.parse(String(init?.body)).user_id;
          return Response.json({
            redirect_url: "https://connect.composio.dev/test-only",
          });
        }
        if (path === "/connected_accounts")
          return Response.json({
            items: connectionActive
              ? [
                  {
                    id: "test-account",
                    user_id: externalUserId,
                    toolkit: { slug: "trello" },
                    status: "ACTIVE",
                  },
                ]
              : [],
          });
        if (path === "/connected_accounts/test-account")
          return Response.json({
            id: "test-account",
            user_id: externalUserId,
            toolkit: { slug: "trello" },
            status: "ACTIVE",
          });
        if (path.endsWith("/revoke")) {
          connectionActive = false;
          return Response.json({ ok: true });
        }
        if (path === "/toolkits")
          return Response.json({
            items: [
              {
                slug: "trello",
                name: "Trello",
                description: "Organize your projects and boards.",
              },
              {
                slug: "miro",
                name: "Miro",
                description: "Explore ideas together.",
              },
            ],
          });
        if (path === "/tools")
          return Response.json({
            items: [
              {
                slug: "TRELLO_GET_BOARDS",
                name: "List my boards",
                description: "Read the boards available to this account.",
                toolkit: { slug: "trello" },
              },
            ],
          });
        if (path === "/tools/TRELLO_GET_BOARDS")
          return Response.json({
            slug: "TRELLO_GET_BOARDS",
            toolkit: { slug: "trello" },
            input_parameters: { type: "object" },
          });
        throw Error("Unexpected test transport call: " + path);
      },
    };
process.env.ORGOPS_MASTER_KEY = Buffer.alloc(32,171).toString('base64');
const engine = createEngine({
  dbPath: join(dir, "engine.sqlite"),
  dataDir: dir,
  adminUser: "owner",
  adminPass: "test-password",
  runnerToken: "test-runner",
});
if (previousRoot === undefined) delete process.env.ORGOPS_PROJECT_ROOT;
else process.env.ORGOPS_PROJECT_ROOT = previousRoot;
let failChannelCreation = true;
const orgops = createOrgOpsClient("http://engine", (async (url, init) => {
  if (failChannelCreation && new URL(String(url)).pathname === "/api/channels" && init?.method === "POST") {
    failChannelCreation = false;
    return Response.json({error:"Test: chat creation temporarily unavailable"},{status:503});
  }
  return engine.app.fetch(new Request(url, init));
}) as typeof fetch);
const product = createApp({
  connections: createComposioProvider(composio),
  connectionEngineToken: "test-runner",
  personalAgent: {
    modelId: "test-model",
    runnerId: "test-runner",
    workspaceRoot: join(dir, "personal"),
  },
  orgops,
  dbPath: join(dir, "product.sqlite"),
});
const uiRequire = createRequire(
  join(process.cwd(), "apps/user-ui/package.json"),
);
const viteCli = join(
  dirname(uiRequire.resolve("vite/package.json")),
  "bin/vite.js",
);
const server = spawn(
  process.execPath,
  [viteCli, "--host", "127.0.0.1", "--port", "5301", "--strictPort"],
  { cwd: join(process.cwd(), "apps/user-ui"), stdio: "pipe" },
);
server.stderr.on("data", (chunk) => process.stderr.write(chunk));
try {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error("Vite timeout")), 20000);
    server.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("5301")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    server.on("error", reject);
  });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1100 },
    });
    page.setDefaultTimeout(15000);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const call = (
      path: string,
      body: unknown,
      headers: Record<string, string>,
    ) =>
      product.app.request(path, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    const login = await call(
      "/api/auth/login",
      { username: "owner", password: "test-password" },
      { "content-type": "application/json" },
    );
    const cookie = login.headers.getSetCookie()[0].split(";")[0],
      headers = { cookie, "content-type": "application/json" };
    await call(
      "/api/models",
      {
        id: "test-model",
        provider: "openrouter",
        modelName: "test-only",
        enabled: true,
      },
      headers,
    );
    await call(
      "/api/runners/register",
      { existingRunnerId: "test-runner", displayName: "Test runner" },
      {
        "x-nest-runner-token": "test-runner",
        "content-type": "application/json",
      },
    );
    await page
      .context()
      .addCookies([
        {
          name: "nest_session",
          value: cookie.slice("nest_session=".length),
          url: "http://127.0.0.1:5301",
          httpOnly: true,
        },
      ]);
    let loseCreation = true;
    await page.route("**/api/**", async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      const r = await product.app.request(url.pathname + url.search, {
        method: request.method(),
        headers: request.headers(),
        ...(request.postDataBuffer()
          ? { body: new Uint8Array(request.postDataBuffer()!) }
          : {}),
      });
      if (
        loseCreation && r.ok &&
        url.pathname === "/api/onboarding/agent" &&
        request.method() === "POST"
      ) {
        loseCreation = false;
        await route.fulfill({
          status: 502,
          json: { error: "Test: response lost after creation" },
        });
        return;
      }
      await route.fulfill({
        status: r.status,
        headers: Object.fromEntries(r.headers),
        body: Buffer.from(await r.arrayBuffer()),
      });
    });
    await page.routeWebSocket("**/ws", (socket) => socket.close());
    await page.goto("http://127.0.0.1:5301/");
    await page
      .getByRole("heading", { name: "Agents", exact:true })
      .waitFor();
    assert.equal(new URL(page.url()).searchParams.get("view"), "agents");
    assert.equal(await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'My agent',exact:true}).count(),0);
    await page.setViewportSize({width:390,height:844});
    await page.getByRole('button',{name:'Add your agent',exact:true}).click();
    await page.setViewportSize({width:1440,height:1100});
    assert.equal(new URL(page.url()).searchParams.get('create'),'personal');
    await page.getByLabel("Agent name", { exact: true }).fill("PuffVitaliy");
    await page
      .getByLabel("What would you like help with?")
      .fill("Plan my week and help me prepare for project meetings.");
    await page.screenshot({
      path: join(screenshots, "meet-agent-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.screenshot({
      path: join(screenshots, "meet-agent-mobile.png"),
      fullPage: true,
    });
    await page
      .getByLabel("Agent name", { exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(screenshots, "agent-form-mobile.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.getByRole("button", { name: "Create agent" }).click();
    await page.getByRole("alert").filter({hasText:"Setup could not finish"}).waitFor();
    // Agent creation succeeded but its chat did not. A fresh visit must expose recovery.
    await page.goto("http://127.0.0.1:5301/");
    await page.getByRole("button",{name:"Resume agent setup",exact:true}).click();
    await page.getByRole("button",{name:"Resume setup",exact:true}).click();
    await page
      .getByRole("alert")
      .filter({ hasText: "response lost" })
      .waitFor();
    await page.reload();
    await page
      .getByRole("heading", { name: "Agent details", exact:true })
      .waitFor();
    assert.equal(
      (
        product.store.db
          .prepare("SELECT COUNT(*) n FROM product_personal_agents")
          .get() as any
      ).n,
      1,
    );
    {
      await page
        .getByRole("button", { name: "Connect account", exact: true })
        .waitFor();
      // Exercise real Nest hosted-link creation without navigating to/authorizing
      // an external account. Only the Composio HTTP transport is a fixture.
      const link = await call(
        "/api/integrations/connections/link",
        { toolkit: "trello" },
        headers,
      );
      assert.equal(link.status, 201);
      connectionActive = true;
      await page.getByRole("button", { name: "Refresh status" }).click();
      await page
        .getByText("Choose tools for PuffVitaliy", { exact: false })
        .click();
      await page
        .getByRole("checkbox", { name: "List my boards", exact: false })
        .check();
      await page.getByRole("button", { name: "Save tool access" }).click();
      await page
        .getByRole("status")
        .filter({ hasText: "Tool access saved" })
        .waitFor();
      const grants = (await (
        await product.app.request("/api/integrations/agents/PuffVitaliy/grants", {
          headers,
        })
      ).json()) as any;
      assert.equal(grants.length, 1);
      assert.deepEqual(grants[0].tools, ["TRELLO_GET_BOARDS"]);
      assert.notEqual(grants[0].connectionId, "test-account");
      await page.getByRole("button",{name:"Enable skill access",exact:true}).click();
      await page.getByRole("button",{name:"Renew skill access",exact:true}).waitFor();
      await page.getByRole("heading", {name:"Connected apps",exact:true}).evaluate(node => node.scrollIntoView({block:"start"}));
      await page.screenshot({
        path: join(screenshots, "connections-desktop.png"),
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      await page.getByRole("heading", {name:"Connected apps",exact:true}).evaluate(node => node.scrollIntoView({block:"start"}));
      await page.screenshot({
        path: join(screenshots, "connections-mobile.png"),
        fullPage: true,
      });
      await page.setViewportSize({ width: 1440, height: 1100 });
      page.once("dialog", (dialog) => void dialog.accept());
      await page
        .getByRole("button", { name: "Disconnect", exact: true })
        .click();
      await page
        .getByText("No apps connected yet.", { exact: false })
        .waitFor();
      const revoked = await (
        await product.app.request("/api/integrations/agents/PuffVitaliy/grants", {
          headers,
        })
      ).json();
      assert.deepEqual(revoked, []);
    }
    await page.getByRole('heading',{name:'Agent details',exact:true}).scrollIntoViewIfNeeded();
    await page.screenshot({path:join(screenshots,'agent-settings-desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:join(screenshots,'agent-settings-mobile.png'),fullPage:true});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.getByRole('button',{name:'Open private chat',exact:true}).click();
    await page.setViewportSize({width:1440,height:1100});
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("Help me plan my week.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByText("Help me plan my week.", { exact: true }).waitFor();
    const setup = product.store.db
      .prepare("SELECT * FROM product_personal_agents")
      .get() as any;
    assert(setup.completed_at);
    assert.equal(
      new URL(page.url()).searchParams.get("channel"),
      setup.channel_id,
    );
    const emit = await call(
      "/api/events",
      {
        type: "message.created",
        source: "agent:PuffVitaliy",
        channelId: setup.channel_id,
        payload: {
          text: "Test agent response: let’s start with your priorities.",
        },
      },
      {
        "content-type": "application/json",
        "x-nest-runner-token": "test-runner",
      },
    );
    assert.equal(emit.status, 201);
    await page.reload();
    await page
      .getByText("Test agent response: let’s start with your priorities.", {
        exact: true,
      })
      .waitFor();
    await page.goto("http://127.0.0.1:5301/");
    await page
      .getByRole("heading", { name: "Dashboard", exact: true })
      .waitFor();
    await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Agents',exact:true}).click();
    await page.getByText('Your personal agent',{exact:true}).waitFor();
    await page.screenshot({path:join(screenshots,'team-desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:join(screenshots,'team-mobile.png'),fullPage:true});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.setViewportSize({width:1440,height:1100});
    await page.getByRole('button',{name:'Manage PuffVitaliy',exact:true}).click();
    await page.getByRole('heading',{name:'Agent details',exact:true}).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('agent'),'PuffVitaliy');
    await page.goBack();await page.getByRole('heading',{name:'Agents',exact:true}).waitFor();
    for(const path of ['/onboarding','/?view=onboarding']){
      await page.goto('http://127.0.0.1:5301'+path);
      await page.getByRole('heading',{name:'Agent details',exact:true}).waitFor();
      assert.equal(new URL(page.url()).pathname,'/');
      assert.equal(new URL(page.url()).searchParams.get('view'),'agents');
      assert.equal(new URL(page.url()).searchParams.get('agent'),'PuffVitaliy');
      assert.equal(await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Agents',exact:true}).getAttribute('aria-current'),'page');
    }
    assert.deepEqual(errors, []);
    console.log(
      "Personal onboarding browser checks passed. Real engine; test-only provider transport; no live model call. Screenshots: " +
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
