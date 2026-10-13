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
let actionPageRequests = 0;
const actionFixtures = [
  {slug:"TRELLO_GET_BOARDS",name:"List my boards",description:"Read the boards available to this account.",toolkit:{slug:"trello"}},
  {slug:"TRELLO_CREATE_CARD",name:"TRELLO_CREATE_CARD",description:"Create a card on a board with a title and description.",toolkit:{slug:"trello"}},
  {slug:"TRELLO_DELETE_CARD",name:"Delete a card",description:"Delete the selected card. This removes it from the board.",toolkit:{slug:"trello"}},
  {slug:"TRELLO_FIND_CARDS",name:"Find cards",description:"Find cards matching a phrase on your boards.",toolkit:{slug:"trello"}},
];
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
              {slug:"gmail",name:"Gmail",description:"Work with your email."},
              {slug:"slack",name:"Slack",description:"Stay connected with your team."},
              {slug:"googledrive",name:"Google Drive",description:"Find and work with your files."},
              {slug:"github",name:"GitHub",description:"Collaborate on your repositories."},
              {slug:"custom_workspace",name:"Custom workspace",description:"Synthetic unknown app for generic-logo fallback."},
            ],
          });
        if (path === "/tools") {
          actionPageRequests++;
          const query = url.searchParams.get("search")?.toLowerCase() ?? "";
          const many = query === "many actions";
          const matching = many ? Array.from({length:101}, (_,index) => ({slug:`TRELLO_BULK_${index}`,name:`Bulk action ${index}`,description:"Synthetic catalog limit fixture.",toolkit:{slug:"trello"}})) : actionFixtures.filter(action => `${action.name} ${action.description} ${action.slug}`.toLowerCase().includes(query));
          const size = many ? 50 : 3;
          const start = Number(url.searchParams.get("cursor") ?? 0);
          return Response.json({items:matching.slice(start,start+size),next_cursor:matching.length>start+size ? String(start+size) : null});
        }
        if (path.startsWith("/tools/")) {
          const action=actionFixtures.find(action=>path==="/tools/"+action.slug);
          if(action) return Response.json({...action,input_parameters:{type:"object"}});
        }
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
    const branding=await product.app.request("/api/branding",{method:"PUT",headers,body:JSON.stringify({displayName:"Camplight",logoUrl:"/brand/camplight-logo-white.svg",primaryColor:"#350956",accentColor:"#ff7557",backgroundColor:"#f8f4ff"})});
    assert(branding.ok);
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
    let rejectAccessSave = false;
    let rejectBulkPage = false;
    await page.route("**/api/**", async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (rejectAccessSave && request.method()==="PUT" && url.pathname.includes("/grants/")) {
        rejectAccessSave=false;
        await route.fulfill({status:503,json:{error:"Test: Saving access is temporarily unavailable."}});
        return;
      }
      if (rejectBulkPage && url.pathname.endsWith("/tools") && url.searchParams.has("cursor")) {
        rejectBulkPage=false;
        await route.fulfill({status:503,json:{error:"Test: next action page unavailable."}});
        return;
      }
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
      await page.getByText("No actions are allowed yet.", {exact:false}).waitFor();
      assert(await page.getByRole("button",{name:"Enable app access",exact:true}).isDisabled());
      await page.getByRole("heading",{name:"App access",exact:true}).evaluate(node => (node.closest("article") ?? node).scrollIntoView({block:"start"}));
      await page.screenshot({path:join(screenshots,"connected-no-tools-desktop.png")});
      await page.setViewportSize({width:390,height:844});
      await page.getByRole("heading",{name:"App access",exact:true}).evaluate(node => (node.closest("article") ?? node).scrollIntoView({block:"start"}));
      await page.screenshot({path:join(screenshots,"connected-no-tools-mobile.png")});
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await page.setViewportSize({width:1440,height:1100});
      const access=page.locator(".connection-permissions");
      const card=page.locator(".onboarding-connection");
      assert.equal(await access.getByRole("checkbox").count(),0,"Granular choices are collapsed by default");
      assert.equal(await access.getByRole("textbox").count(),0);
      assert.equal(actionPageRequests,0,"The default view does not fetch the action catalog");
      assert((await card.boundingBox())!.height<260,"Default connected account stays compact on desktop");
      async function captureConnection(name:string) {
        await page.evaluate(()=>document.fonts.ready);
        await page.locator(".onboarding-connections img").evaluateAll(images=>Promise.all(images.map(image=>(image as HTMLImageElement).decode().catch(()=>{}))));
        await card.evaluate(node=>node.scrollIntoView({block:"start"}));
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await page.screenshot({path:join(screenshots,name),animations:"disabled"});
      }
      await captureConnection("connections-compact-desktop.png");
      for (const image of await page.locator(".onboarding-connections img").all()) assert(await image.evaluate(node=>(node as HTMLImageElement).naturalWidth>0),"App logos load locally");
      assert.equal(await page.locator(".connection-app-logo.is-generic").count(),1);
      await page.setViewportSize({width:390,height:844});
      await captureConnection("connections-compact-mobile.png");
      assert((await card.boundingBox())!.height<360,"Default connected account stays compact on mobile");
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await page.setViewportSize({width:1440,height:1100});
      rejectBulkPage=true;
      await access.getByRole("button",{name:"Give all access",exact:true}).click();
      await access.getByRole("alert").filter({hasText:"We couldn’t load all actions"}).waitFor();
      assert.equal((await (await product.app.request("/api/integrations/agents/PuffVitaliy/grants",{headers})).json()).length,0,"Give all does not write after a page failure");
      rejectAccessSave=true;
      await access.getByRole("button",{name:"Give all access",exact:true}).click();
      await access.getByRole("alert").filter({hasText:"Saving access is temporarily unavailable"}).waitFor();
      assert.equal((await (await product.app.request("/api/integrations/agents/PuffVitaliy/grants",{headers})).json()).length,0,"Give all only reports success after saving");
      assert.equal(await access.getByRole("button",{name:"All access given",exact:true}).count(),0);
      await access.getByRole("button",{name:"Give all access",exact:true}).click();
      await access.getByRole("status").filter({hasText:"4 actions allowed"}).waitFor();
      assert(await access.getByRole("button",{name:"All access given",exact:true}).isDisabled());
      const directGrants=await (await product.app.request("/api/integrations/agents/PuffVitaliy/grants",{headers})).json() as any;
      assert.deepEqual(directGrants[0].tools.sort(),actionFixtures.map(action=>action.slug).sort(),"Give all saves all pages in one explicit action");
      assert.equal(await access.getByRole("checkbox").count(),0);
      await captureConnection("connections-all-given-desktop.png");
      await page.setViewportSize({width:390,height:844});
      await captureConnection("connections-all-given-mobile.png");
      await page.setViewportSize({width:1440,height:1100});
      await access.getByText("Choose specific actions",{exact:true}).click();
      await access.getByRole("checkbox",{name:"List my boards",exact:true}).waitFor();
      await access.getByRole("button",{name:"Clear all choices",exact:true}).click();
      await access.getByRole("button",{name:"Save access",exact:true}).click();
      await access.getByRole("status").filter({hasText:"Not allowed yet"}).waitFor();
      await page.waitForFunction(()=>!!([...document.querySelectorAll('button')].find(button=>button.textContent==='Enable app access') as HTMLButtonElement)?.disabled);
      await page
        .getByRole("checkbox", { name: "List my boards", exact: false })
        .check();
      assert(await page.getByRole("button",{name:"Enable app access",exact:true}).isDisabled(),"Unsaved selection grants no access");
      const picker=page.locator(".connection-picker");
      const query=picker.getByRole("textbox",{name:"Find an action",exact:true});
      await picker.getByRole("checkbox",{name:"Create card",exact:true}).check();
      await picker.getByText("Changes not saved yet",{exact:true}).waitFor();
      await picker.getByRole("button",{name:"Discard changes",exact:true}).click();
      assert.equal(await picker.getByRole("checkbox",{checked:true}).count(),0);
      await picker.getByRole("checkbox",{name:"List my boards",exact:true}).check();
      rejectBulkPage=true;
      await picker.getByRole("button",{name:"Select all",exact:true}).click();
      await access.getByRole("alert").filter({hasText:"We couldn’t load all actions"}).waitFor();
      assert.equal(await picker.getByRole("checkbox",{checked:true}).count(),1,"A failed page must not partially apply bulk choices");
      await picker.getByRole("button",{name:"Select all",exact:true}).click();
      await picker.getByRole("status").filter({hasText:"4 actions selected"}).waitFor();
      assert.equal(await picker.getByRole("checkbox",{checked:true}).count(),4,"Select all includes unloaded provider pages");
      assert(await picker.getByRole("checkbox",{name:"Find cards",exact:true}).isChecked());
      assert(await picker.getByRole("button",{name:"Select all",exact:true}).isDisabled());
      assert(await page.getByRole("button",{name:"Enable app access",exact:true}).isDisabled(),"Bulk selection grants no access until saved");
      assert.deepEqual((await (await product.app.request("/api/integrations/agents/PuffVitaliy/grants",{headers})).json() as any)[0].tools,[]);
      await captureActions("actions-all-desktop.png");
      await page.setViewportSize({width:390,height:844});
      await captureActions("actions-all-mobile.png");
      await picker.locator(".connection-picker-footer").scrollIntoViewIfNeeded();
      await page.screenshot({path:join(screenshots,"actions-all-mobile-footer.png"),animations:"disabled"});
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await page.setViewportSize({width:1440,height:1100});
      await picker.getByRole("button",{name:"Discard changes",exact:true}).click();
      await picker.getByRole("checkbox",{name:"List my boards",exact:true}).check();
      await query.fill("many actions");
      await picker.getByRole("checkbox",{name:"Bulk action 0",exact:true}).waitFor();
      await picker.getByRole("button",{name:"Select all results",exact:true}).click();
      await access.getByRole("alert").filter({hasText:"exceed the 100-action limit"}).waitFor();
      await picker.getByRole("status").filter({hasText:"1 action selected"}).waitFor();
      assert.equal(await picker.getByRole("checkbox",{checked:true}).count(),0,"Oversized bulk selection must not add partial results");
      await query.fill("card");
      await picker.getByRole("checkbox",{name:"Create card",exact:true}).waitFor();
      await picker.getByRole("button",{name:"Select all results",exact:true}).click();
      await picker.getByRole("status").filter({hasText:"4 actions selected"}).waitFor();
      assert.equal(await picker.getByRole("checkbox",{checked:true}).count(),3,"Search bulk selection keeps the prior off-search choice");
      await picker.getByRole("button",{name:"Discard changes",exact:true}).click();
      await query.fill("");
      await picker.getByRole("checkbox",{name:"List my boards",exact:true}).waitFor();
      await picker.getByRole("checkbox",{name:"List my boards",exact:true}).check();
      await picker.getByRole("button",{name:"Show more actions",exact:true}).click();
      await picker.getByRole("checkbox",{name:"Find cards",exact:true}).check();
      await query.fill("List my boards");
      await picker.getByRole("button",{name:/^Selected/}).click();
      assert.equal(await picker.getByRole("checkbox").count(),1);
      await query.fill("");
      await picker.getByRole("checkbox",{name:"Find cards",exact:true}).waitFor();
      assert.equal(await picker.getByRole("checkbox",{checked:true}).count(),2,"Search/page changes preserve choices");
      await captureActions("actions-selected-desktop.png");
      await picker.getByRole("checkbox",{name:"Find cards",exact:true}).click();
      assert.equal(await picker.getByRole("checkbox").count(),1);
      await picker.getByRole("button",{name:"Available actions",exact:true}).click();
      await picker.getByRole("checkbox",{name:"Create card",exact:true}).waitFor();
      await query.fill("nothing-matches");
      await picker.getByText("No matching actions",{exact:true}).waitFor();
      await query.fill("");
      await picker.getByRole("checkbox",{name:"Create card",exact:true}).waitFor();
      const details=picker.locator(".connection-action-card").filter({hasText:"Delete a card"});
      await details.getByText("About this action",{exact:true}).click();
      await details.getByText("Action reference:",{exact:false}).waitFor();
      await details.getByText("About this action",{exact:true}).click();
      await picker.getByRole("checkbox",{name:"Create card",exact:true}).check();
      async function captureActions(name:string) {
        await page.evaluate(()=>document.fonts.ready);
        await picker.evaluate(node=>node.scrollIntoView({block:"start"}));
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await page.screenshot({path:join(screenshots,name),animations:"disabled"});
      }
      await captureActions("actions-unsaved-desktop.png");
      await page.setViewportSize({width:390,height:844});
      await captureActions("actions-unsaved-mobile.png");
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await page.setViewportSize({width:1440,height:1100});
      await picker.getByRole("checkbox",{name:"Create card",exact:true}).uncheck();
      rejectAccessSave=true;
      await picker.getByRole("button",{name:"Save access",exact:true}).click();
      await access.getByRole("alert").filter({hasText:"Saving access is temporarily unavailable"}).waitFor();
      assert(await picker.getByRole("checkbox",{name:"List my boards",exact:true}).isChecked());
      assert.deepEqual((await (await product.app.request("/api/integrations/agents/PuffVitaliy/grants",{headers})).json() as any)[0].tools,[],"Failed save grants no actions");
      await picker.getByRole("button",{name:"Save access",exact:true}).click();
      await page
        .getByRole("status")
        .filter({ hasText: "Access saved" })
        .waitFor();
      const grants = (await (
        await product.app.request("/api/integrations/agents/PuffVitaliy/grants", {
          headers,
        })
      ).json()) as any;
      assert.equal(grants.length, 1);
      assert.deepEqual(grants[0].tools, ["TRELLO_GET_BOARDS"]);
      assert.notEqual(grants[0].connectionId, "test-account");
      assert(await picker.getByRole("button",{name:"Save access",exact:true}).isDisabled());
      await query.fill("card");
      await picker.getByRole("checkbox",{name:"Create card",exact:true}).waitFor();
      await access.getByRole("button",{name:"Give all access",exact:true}).click();
      await access.getByRole("status").filter({hasText:"4 actions allowed"}).waitFor();
      assert.equal(await access.getByRole("textbox").count(),0,"Give all collapses advanced choices after success");
      const bulkGrants = await (await product.app.request("/api/integrations/agents/PuffVitaliy/grants",{headers})).json() as any;
      assert.deepEqual(bulkGrants[0].tools.sort(),actionFixtures.map(action=>action.slug).sort(),"Give all ignores the advanced search and grants the full catalog");
      await access.getByText("Choose specific actions",{exact:true}).click();
      await picker.getByRole("checkbox",{name:"List my boards",exact:true}).waitFor();
      await picker.getByRole("button",{name:"Show more actions",exact:true}).click();
      await picker.getByRole("checkbox",{name:"Find cards",exact:true}).waitFor();
      for (const name of ["Create card", "Delete a card", "Find cards"]) await picker.getByRole("checkbox",{name,exact:true}).uncheck();
      await picker.getByRole("button",{name:"Save access",exact:true}).click();
      await picker.getByRole("status").filter({hasText:"Access saved"}).waitFor();
      await captureActions("actions-saved-desktop.png");
      await page.setViewportSize({width:390,height:844});
      await captureActions("actions-saved-mobile.png");
      await picker.locator(".connection-picker-footer").scrollIntoViewIfNeeded();
      await page.screenshot({path:join(screenshots,"actions-saved-mobile-footer.png")});
      await picker.getByRole("button",{name:"Clear all choices",exact:true}).click();
      assert.equal(await picker.getByRole("checkbox",{checked:true}).count(),0);
      await picker.getByRole("button",{name:"Discard changes",exact:true}).click();
      assert(await picker.getByRole("checkbox",{name:"List my boards",exact:true}).isChecked());
      await page.setViewportSize({width:1440,height:1100});
      await page.getByRole("button",{name:"Switch to dark theme",exact:true}).click();
      await captureActions("actions-dark-desktop.png");
      await access.getByText("Choose specific actions",{exact:true}).click();
      await captureConnection("connections-compact-dark.png");
      await page.getByRole("button",{name:"Switch to light theme",exact:true}).click();
      // Reproduce the automatic runner channel that previously blocked every
      // running personal agent. Exercise the real engine HTTP endpoints.
      const runnerHeaders = { "content-type": "application/json", "x-orgops-runner-token": "test-runner" };
      const lifecycleResponse = await engine.app.request("/api/channels", {
        method: "POST", headers: runnerHeaders,
        body: JSON.stringify({ name: "agent.lifecycle.PuffVitaliy", description: "Lifecycle bootstrap channel for PuffVitaliy", kind: "GROUP" }),
      });
      assert.equal(lifecycleResponse.status, 201);
      const lifecycleId = (await lifecycleResponse.json()).id;
      assert((await engine.app.request(`/api/channels/${lifecycleId}/subscribe`, {
        method: "POST", headers: runnerHeaders,
        body: JSON.stringify({ subscriberType: "AGENT", subscriberId: "PuffVitaliy" }),
      })).ok);
      await page.waitForFunction(()=>!([...document.querySelectorAll('button')].find(button=>button.textContent==='Enable app access') as HTMLButtonElement)?.disabled);
      await page.getByRole("button",{name:"Enable app access",exact:true}).click();
      await page.getByRole("button",{name:"Renew app access",exact:true}).waitFor();
      await page.getByText("Ready for your next message.",{exact:true}).waitFor();
      const enabledAgent=await (await product.app.request("/api/agents/PuffVitaliy",{headers})).json();
      assert(enabledAgent.alwaysPreloadedSkills.includes("nest-connections"));
      // Older credentials remain owner-controlled; Renewal installs the preload.
      assert((await product.app.request("/api/agents/PuffVitaliy",{method:"PATCH",headers,body:JSON.stringify({alwaysPreloadedSkills:[]})})).ok);
      await page.getByRole("button",{name:"Refresh status",exact:true}).click();
      await page.getByText("Renew access before your next message.",{exact:true}).waitFor();
      await page.getByRole("button",{name:"Renew app access",exact:true}).click();
      await page.getByText("Ready for your next message.",{exact:true}).waitFor();
      await page.getByRole("heading",{name:"App access",exact:true}).evaluate(node => (node.closest("article") ?? node).scrollIntoView({block:"start"}));
      await page.screenshot({path:join(screenshots,"saved-tools-enabled-desktop.png")});
      await page.setViewportSize({width:390,height:844});
      await page.getByRole("heading",{name:"App access",exact:true}).evaluate(node => (node.closest("article") ?? node).scrollIntoView({block:"start"}));
      await page.screenshot({path:join(screenshots,"saved-tools-enabled-mobile.png")});
      await page.setViewportSize({width:1440,height:1100});
      const secured = (await (await product.app.request("/api/channels", { headers })).json()).find((channel: any) => channel.id === lifecycleId);
      assert.equal(secured.visibility, "PRIVATE");
      assert(secured.ownerHumanId);
      // A real eligibility error must survive the UI, rather than blaming runner setup.
      assert((await product.app.request("/api/humans/invite", {
        method: "POST", headers, body: JSON.stringify({ username: "observer", tempPassword: "test-password" }),
      })).ok);
      assert((await product.app.request(`/api/channels/${lifecycleId}/subscribe`, {
        method: "POST", headers, body: JSON.stringify({ subscriberType: "HUMAN", subscriberId: "observer" }),
      })).ok);
      await page.getByRole("button", { name: "Renew app access", exact: true }).click();
      await page.getByRole("alert").filter({ hasText: "lifecycle channel must be private" }).waitFor();
      await page.getByRole("heading", { name: "App access", exact: true }).evaluate(node => node.scrollIntoView({ block: "start" }));
      await page.screenshot({ path: join(screenshots, "skill-access-error-desktop.png"), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("heading", { name: "App access", exact: true }).evaluate(node => node.scrollIntoView({ block: "start" }));
      await page.screenshot({ path: join(screenshots, "skill-access-error-mobile.png"), fullPage: true });
      await page.setViewportSize({ width: 1440, height: 1100 });
      assert((await product.app.request(`/api/channels/${lifecycleId}/unsubscribe`, {
        method: "POST", headers, body: JSON.stringify({ subscriberType: "HUMAN", subscriberId: "observer" }),
      })).ok);
      await page.getByRole("button", { name: "Renew app access", exact: true }).click();
      await page.getByRole("alert").filter({ hasText: "lifecycle channel must be private" }).waitFor({ state: "hidden" });
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
