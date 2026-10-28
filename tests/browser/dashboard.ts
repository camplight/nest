import { chromium, webkit } from "playwright";
import assert from "node:assert/strict";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createEngine } from "./engine";
import { createOrgOpsClient } from "../../packages/orgops-client/src/index";
import { createApp } from "../../apps/api/src/app";
import type { Task } from "../../packages/schemas/src/projects";

const dir = mkdtempSync(join(tmpdir(), "nest-dashboard-browser-"));
const screenshots = mkdtempSync(join(tmpdir(), "nest-dashboard-screenshots-"));
const before = process.env.NEST_DASHBOARD_BEFORE === "1";
const previousRoot = process.env.ORGOPS_PROJECT_ROOT;
process.env.ORGOPS_PROJECT_ROOT = dir;
const engine = createEngine({
  dbPath: join(dir, "engine.sqlite"),
  dataDir: dir,
  adminUser: "owner",
  adminPass: "test-password",
  runnerToken: "test-runner",
});
if (previousRoot === undefined) delete process.env.ORGOPS_PROJECT_ROOT;
else process.env.ORGOPS_PROJECT_ROOT = previousRoot;
const orgops = createOrgOpsClient("http://engine", (async (url, init) =>
  engine.app.fetch(new Request(url, init))) as typeof fetch);
const product = createApp({
  orgops,
  dbPath: join(dir, "product.sqlite"),
  connections: null,
});
const uiRequire = createRequire(
  join(process.cwd(), "apps/user-ui/package.json"),
);
const apiRequire = createRequire(join(process.cwd(), "apps/api/package.json"));
const { serve } = apiRequire("@hono/node-server");
const backend = serve({
  fetch: product.app.fetch,
  hostname: "127.0.0.1",
  port: 0,
});
await once(backend, "listening");
const backendUrl = `http://127.0.0.1:${backend.address().port}`;
const { createServer } = await import(uiRequire.resolve("vite"));
const reference = before
  ? {
      name: "dashboard-before-reference",
      enforce: "pre" as const,
      load(id: string) {
        for (const file of ["App.tsx", "Dashboard.tsx", "dashboard.css"])
          if (
            id.split("?")[0] === join(process.cwd(), "apps/user-ui/src", file)
          )
            return execFileSync(
              "git",
              [
                "show",
                `192dd85a8fca3e1d5a6d389a898d7f9ea683effa:apps/user-ui/src/${file}`,
              ],
              { encoding: "utf8" },
            );
      },
    }
  : null;
const server = await createServer({
  root: join(process.cwd(), "apps/user-ui"),
  plugins: reference ? [reference] : [],
  server: {
    host: "127.0.0.1",
    port: 5312,
    strictPort: true,
    proxy: { "/api": backendUrl },
  },
});
try {
  await server.listen();
  const browser = await (process.argv.includes("--webkit")?webkit:chromium).launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1290 },
      reducedMotion: "no-preference",
      hasTouch: true,
    });
    page.setDefaultTimeout(15000);
    async function capture(name: string) {
      await page.evaluate(() => document.fonts.ready);
      await page.waitForFunction(() =>
        [...document.images].every(
          (image) => image.complete && image.naturalWidth > 0,
        ),
      );
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      await page.screenshot({
        path: join(screenshots, name),
        animations: "disabled",
      });
    }
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const login = await product.app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "test-password" }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const headers = { cookie, "content-type": "application/json" };
    async function request(
      path: string,
      body?: unknown,
      method = body === undefined ? "GET" : "POST",
      h = headers,
    ) {
      const result = await product.app.request(path, {
        method,
        headers: h,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      assert(
        result.ok,
        `${method} ${path}: ${result.status} ${result.ok ? "" : await result.text()}`,
      );
      return result.json();
    }
    await request(
      "/api/branding",
      {
        displayName: "Camplight",
        logoUrl: "/brand/camplight-logo-white.svg",
        primaryColor: "#350956",
        accentColor: "#ff7557",
        backgroundColor: "#f8f4ff",
      },
      "PUT",
    );
    for (const name of ["Puff", "Pip", "Pom"])
      await request("/api/agents", {
        name,
        visibility: "PRIVATE",
        modelId: "test-model",
        workspacePath: join(dir, name),
      });
    const ids: string[] = [];
    let reviewTask: Task;
    let reviewProject = "";
    for (const [name, agent] of [
      ["landing-page-redesign", "Pom"],
      ["backend-infra", "Pip"],
      ["product-strategy", "Puff"],
    ]) {
      const project = await request("/api/projects", {
        id: randomUUID(),
        name,
        description: "Synthetic dashboard validation project.",
      });
      ids.push(project.id);
      const task = await request(`/api/projects/${project.id}/tasks`, {
        id: randomUUID(),
        title: `Review ${name} proposal`,
        instructions: "Prepare a proposal with evidence.",
        acceptanceCriteria: "A clear plan and supporting evidence.",
        agentName: agent,
      });
      const path = `/api/projects/${project.id}/tasks/${task.id}`;
      const working = await request(path + "/dispatch", {
        version: task.version,
      });
      // Runner event + human-selected deliverable exercise the actual workflow.
      await new Promise((resolve) => setTimeout(resolve, 2));
      const event = await request(
        "/api/events",
        {
          type: "message.created",
          source: `agent:${agent}`,
          channelId: project.channelId,
          payload: {
            text: "Synthetic proposal: implement an accessible workflow with verified examples.",
          },
        },
        "POST",
        {
          "content-type": "application/json",
          "x-nest-runner-token": "test-runner",
        },
      );
      const submitted = await request(path + "/deliverables", {
        version: working.version,
        eventId: event.id,
      });
      if (name === "landing-page-redesign") {
        await request(path + "/reviews", {
          version: submitted.version,
          decision: "approve",
        });
        await request(`/api/projects/${project.id}/tasks`, {
          id: randomUUID(),
          title: "Add keyboard navigation",
          instructions: "Add keyboard access.",
          acceptanceCriteria: "All actions can be reached.",
          agentName: agent,
        });
      } else if (name === "backend-infra") {
        reviewTask = submitted;
        reviewProject = project.id;
      } else
        await request(path + "/reviews", {
          version: submitted.version,
          decision: "request_changes",
          feedback: "Include keyboard examples.",
        });
    }
    for (const [name, title, category] of [
      ["weekly-product-pulse", "Weekly Product Pulse", "automation"],
      ["acceptance-review", "Acceptance Review", "skill"],
      ["project-kickoff", "Project Kickoff", "use-case"],
    ]) {
      const manifest = {
        name,
        title,
        description:
          "Collect feedback, summarize key themes and prepare a useful next step for your team.",
        version: "1.0.0",
        category,
        license: "Proprietary",
        tags: ["product"],
        runtimes: ["generic"],
      };
      await request("/api/community/skills", {
        schemaVersion: 1,
        manifest,
        files: [
          {
            path: "SKILL.md",
            content: `---\nname: ${name}\ndescription: ${manifest.description}\nlicense: Proprietary\n---\n\nRead supplied feedback and return a summary with evidence and useful next steps. This is synthetic test data.\n`,
          },
        ],
      });
    }
    await page.context().addCookies([
      {
        name: "nest_session",
        value: cookie.slice("nest_session=".length),
        url: "http://127.0.0.1:5312",
        httpOnly: true,
      },
    ]);
    await page.routeWebSocket("**/ws", (socket) => socket.close());
    await page.goto("http://127.0.0.1:5312/?view=dashboard");
    await page
      .getByRole("heading", { name: "Dashboard", exact: true })
      .waitFor();
    await page.waitForFunction(
      () =>
        document
          .querySelector(".dashboard-content")
          ?.getAttribute("aria-busy") === "false",
    );
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".dashboard img,.sidebar img")].every(
        (image: any) => image.complete && image.naturalWidth > 0,
      ),
    );
    await page.evaluate(() => document.fonts.ready);
    if (before) {
      await capture("dashboard-before-desktop.png");
      await page.setViewportSize({ width: 390, height: 844 });
      await capture("dashboard-before-mobile.png");
      console.log(
        `PASS: before reference with synthetic data. Screenshots: ${screenshots}`,
      );
    } else {
      const controls = page.getByRole("group", { name: "Workspace controls" });
      assert.equal(await controls.getByRole("button").count(), 5);
      assert(await controls.getByRole("button", {name:"Quick tour",exact:true}).isVisible());
      assert.deepEqual(
        await controls.locator("img").evaluateAll((images) =>
          images.map((img) => {
            const r = img.getBoundingClientRect();
            return [r.width, r.height];
          }),
        ),
        [
          [42, 41],
          [40, 42],
          [42, 40],
          [41, 40],
        ],
      );
      await page.getByRole("button", { name: "Account", exact: true }).click();
      await page
        .getByRole("menu", { name: "Account menu" })
        .getByText("owner", { exact: true })
        .waitFor();
      await capture("header-account-desktop.png");
      await page.keyboard.press("Escape");
      assert(
        await page
          .getByRole("button", { name: "Account", exact: true })
          .evaluate((el) => el === document.activeElement),
      );
      await page.route("**/api/branding/access", (route) =>
        route.fulfill({ status: 503, json: { error: "Test: unavailable" } }),
      );
      await page
        .getByRole("button", { name: "Workspace settings", exact: true })
        .click();
      const settings = page.getByRole("dialog", { name: "Workspace settings" });
      await settings.getByRole("alert").waitFor();
      await settings
        .getByRole("button", { name: "Switch to dark theme" })
        .click();
      await page.waitForFunction(
        () => document.documentElement.dataset.theme === "dark",
      );
      assert.equal(
        await page
          .locator(".workspace-controls > .nest-theme-toggle")
          .getAttribute("aria-label"),
        "Switch to light theme",
      );
      await settings
        .getByRole("button", { name: "Switch to light theme" })
        .click();
      await page.unroute("**/api/branding/access");
      await settings
        .getByRole("button", { name: "Retry access check" })
        .click();
      assert.equal(
        await settings
          .getByRole("link", { name: "Open administration →" })
          .getAttribute("href"),
        "/admin/",
      );
      await capture("header-settings-desktop.png");
      await page.keyboard.press("Escape");
      assert(
        await page
          .getByRole("button", { name: "Workspace settings", exact: true })
          .evaluate((el) => el === document.activeElement),
      );
      const nav = page.getByRole("navigation", { name: "Main navigation" });
      assert.equal(await nav.getByRole("button", { name: "Skills", exact: true }).count(), 0);
      await nav.getByRole("button", { name: "Community", exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll(".community-card").length === 3);
      assert.equal(new URL(page.url()).searchParams.get("category"), null);
      assert.equal(await nav.getByRole("button", { name: "Community", exact: true }).getAttribute("aria-current"), "page");
      await page.reload();
      await page.waitForFunction(() => document.querySelectorAll(".community-card").length === 3);
      await nav.getByRole("button", { name: "Projects", exact: true }).click();
      await page
        .getByRole("textbox", { name: "Search projects" })
        .fill("backend");
      await page.waitForFunction(
        () =>
          document.querySelectorAll(".project-grid .project-summary").length ===
          1,
      );
      await nav.getByRole("button", { name: "Agents", exact: true }).click();
      assert.equal(
        await page
          .getByRole("group", { name: "Workspace controls" })
          .getByRole("button")
          .count(),
        5,
      );
      await nav.getByRole("button", { name: "Dashboard", exact: true }).click();
      const room = (await request(`/api/projects/${reviewProject}`)).channelId;
      await request("/api/humans/invite", {
        username: "header-reviewer",
        tempPassword: "test-password",
      });
      // Complete the invited human's required password change through the real API.
      const reviewerResponse = await product.app.request("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: "header-reviewer",
          password: "test-password",
        }),
      });
      let reviewerCookie = reviewerResponse.headers
        .get("set-cookie")!
        .split(";")[0];
      const reviewerHeaders = {
        cookie: reviewerCookie,
        "content-type": "application/json",
      };
      const changed = await product.app.request("/api/auth/profile", {
        method: "PATCH",
        headers: reviewerHeaders,
        body: JSON.stringify({
          username: "header-reviewer",
          newPassword: "reviewer-test-password",
        }),
      });
      assert.equal(changed.status, 200);
      reviewerCookie =
        changed.headers.get("set-cookie")?.split(";")[0] ?? reviewerCookie;
      reviewerHeaders.cookie = reviewerCookie;
      await request(`/api/channels/${room}/subscribe`, {
        subscriberType: "HUMAN",
        subscriberId: "header-reviewer",
      });
      await request(
        "/api/messages",
        {
          id: randomUUID(),
          channelId: room,
          text: "@owner Please review the launch proposal.",
          mentions: [{ kind: "HUMAN", name: "owner", start: 0, end: 6 }],
        },
        "POST",
        reviewerHeaders,
      );
      await page
        .getByRole("button", { name: "Notifications", exact: true })
        .click();
      const inbox = page.getByRole("dialog", { name: "Your mentions" });
      await inbox
        .getByText("header-reviewer mentioned you", { exact: true })
        .waitFor();
      await inbox.getByText("backend-infra", { exact: true }).waitFor();
      await capture("header-notifications-desktop.png");
      await inbox
        .getByRole("button")
        .filter({ hasText: "header-reviewer mentioned you" })
        .click();
      await page.waitForURL(
        (url) =>
          url.searchParams.get("project") === reviewProject &&
          Boolean(url.searchParams.get("message")),
      );
      assert.equal(
        new URL(page.url()).searchParams.get("project"),
        reviewProject,
      );
      assert(new URL(page.url()).searchParams.get("message"));
      const notices = await request("/api/mentions");
      assert(notices.items[0].readAt);
      await nav.getByRole("button", { name: "Dashboard", exact: true }).click();
      await page.waitForFunction(
        () =>
          document.querySelector('[aria-label="Finished tasks"]')
            ?.textContent === "1",
      );
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await controls.getByRole("button").count(), 5);
      await capture("header-mobile.png");
      await page.getByRole("button", { name: "Account", exact: true }).click();
      await capture("header-account-mobile.png");
      await page.keyboard.press("Escape");
      await page
        .getByRole("button", { name: "Notifications", exact: true })
        .click();
      await page.getByRole("dialog", { name: "Your mentions" }).waitFor();
      await capture("header-notifications-mobile.png");
      await page.keyboard.press("Escape");
      await page
        .getByRole("button", { name: "Workspace settings", exact: true })
        .click();
      await settings
        .getByRole("link", { name: "Open administration →" })
        .waitFor();
      await capture("header-settings-mobile.png");
      await settings
        .getByRole("button", { name: "Close workspace settings" })
        .click();
      await page.setViewportSize({ width: 1440, height: 1290 });
      // Connected-account callbacks can return to a standalone personal chat.
      // They must retain the product header without introducing a second one
      // inside project chats or changing the underlying channel membership.
      const personal = await request("/api/channels/direct/human-agent", {agentName:"Puff"});
      await page.goto(`http://127.0.0.1:5312/?status=success&connected_account_id=synthetic-account&channel=${personal.id}`);
      await page.getByRole("textbox", {name:"Message",exact:true}).waitFor();
      assert.equal(await page.locator(".workspace-topbar").count(),1);
      assert.equal(await controls.getByRole("button").count(), 5);
      await page.getByRole("button", {name:"Manage channel",exact:true}).waitFor();
      assert.equal(await page.locator(".sidebar .mention-inbox,.sidebar .account-actions").count(),0);
      await page.getByRole("textbox", {name:"Search channels",exact:true}).fill("unmatched-channel");
      await page.getByText('No channels match "unmatched-channel".',{exact:true}).waitFor();
      await page.getByRole("textbox", {name:"Search channels",exact:true}).fill("");
      await page.getByRole("button", {name:"Account",exact:true}).click();
      await page.getByRole("menu", {name:"Account menu"}).getByText("owner",{exact:true}).waitFor();
      await page.keyboard.press("Escape");
      await page.getByRole("button", {name:"Workspace settings",exact:true}).click();
      await settings.getByRole("link",{name:"Open administration →"}).waitFor();
      await page.getByRole("button",{name:"Close workspace settings"}).click();
      await page.getByRole("button",{name:"Notifications",exact:true}).click();
      await inbox.waitFor();
      await page.keyboard.press("Escape");
      await capture("standalone-chat-desktop.png");
      await page.reload();
      await page.getByRole("textbox", {name:"Message",exact:true}).waitFor();
      assert.equal(new URL(page.url()).searchParams.get("channel"),personal.id);
      assert.equal(await page.locator(".workspace-topbar").count(),1);
      await page.setViewportSize({width:390,height:844});
      await page.getByRole("button", {name:"Menu",exact:true}).click();
      await nav.getByRole("button", {name:"Projects",exact:true}).waitFor();
      await page.getByRole("button",{name:"Close",exact:true}).click();
      await capture("standalone-chat-mobile.png");
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
      const composer=await page.getByRole("textbox",{name:"Message",exact:true}).boundingBox();
      assert(composer&&composer.y>=0&&composer.y+composer.height<=844,"Composer stays visible");
      for(const name of ["Account","Workspace settings","Notifications"]) {
        const box=await page.getByRole("button",{name,exact:true}).boundingBox();
        assert(box&&box.x>=0&&box.x+box.width<=390,"Header controls stay visible");
      }
      await page.setViewportSize({width:1440,height:1290});
      await nav.getByRole("button",{name:"Projects",exact:true}).click();
      await page.locator(".project-summary").filter({hasText:"backend-infra"}).first().click();
      await page.getByRole("textbox",{name:"Message",exact:true}).waitFor();
      assert.equal(await page.locator(".workspace-topbar").count(),1,"Project chat has one header");
      await nav.getByRole("button",{name:"Dashboard",exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('[aria-label="Finished tasks"]')?.textContent==="1");
      // A separate authenticated human gets personal settings but no owner link.
      const guest = await browser.newContext({
        viewport: { width: 390, height: 844 },
      });
      await guest.addCookies([
        {
          name: "nest_session",
          value: reviewerCookie.slice("nest_session=".length),
          url: "http://127.0.0.1:5312",
          httpOnly: true,
        },
      ]);
      const guestPage = await guest.newPage();
      await guestPage.routeWebSocket("**/ws", (socket) => socket.close());
      await guestPage.goto("http://127.0.0.1:5312/?view=dashboard");
      await guestPage
        .getByRole("button", { name: "Workspace settings", exact: true })
        .click();
      const guestSettings = guestPage.getByRole("dialog", {
        name: "Workspace settings",
      });
      await guestSettings
        .getByText("Instance settings are managed by your administrator.")
        .waitFor();
      assert.equal(
        await guestSettings
          .getByRole("link", { name: "Open administration →" })
          .count(),
        0,
      );
      await guestSettings
        .getByRole("button", { name: "Close workspace settings" })
        .click();
      await guestPage
        .getByRole("button", { name: "Account", exact: true })
        .click();
      await guestPage
        .getByRole("menu", { name: "Account menu" })
        .getByText("header-reviewer", { exact: true })
        .waitFor();
      await guestPage
        .getByRole("menuitem", { name: "Sign out", exact: true })
        .click();
      await guestPage
        .getByRole("button", { name: "Continue", exact: true })
        .waitFor();
      assert.equal(
        (await guest.request.get("http://127.0.0.1:5312/api/auth/me")).status(),
        401,
      );
      await guest.close();
      assert.equal(
        await page.getByLabel("Finished tasks", { exact: true }).textContent(),
        "1",
      );
      await page
        .locator('[aria-label="Task filter"]')
        .getByRole("button", { name: "Need review", exact: true })
        .click();
      assert.equal(
        await page
          .getByLabel("Tasks needing review", { exact: true })
          .textContent(),
        "1",
      );
      assert.equal(
        await page.getByLabel("Spend unavailable").textContent(),
        "—",
      );
      assert.equal(
        await page.getByLabel("Issues unavailable").textContent(),
        "—",
      );
      const projects = page.locator('section[aria-label="Active projects"]');
      await projects
        .getByRole("group", {
          name: "Active projects cards. Use arrow keys to navigate.",
        })
        .focus();
      await page.keyboard.press("End");
      await projects.getByText("50% done", { exact: true }).waitFor();
      await page.keyboard.press("Home");
      await page.locator(".dashboard-title h1").click();
      await capture("dashboard-desktop.png");
      await page.getByRole("button", { name: "Review →", exact: true }).click();
      assert.equal(
        new URL(page.url()).searchParams.get("project"),
        reviewProject,
      );
      assert.equal(
        new URL(page.url()).searchParams.get("task"),
        reviewTask!.id,
      );
      await page
        .getByRole("button", { name: "Approve deliverable", exact: true })
        .waitFor();
      await page.goBack();
      await page
        .getByRole("heading", { name: "Dashboard", exact: true })
        .waitFor();
      await page
        .locator(".dashboard-community-card")
        .filter({ hasText: "Weekly Product Pulse" })
        .click();
      assert.equal(
        new URL(page.url()).searchParams.get("skill"),
        "weekly-product-pulse",
      );
      await page
        .getByRole("heading", { name: "Weekly Product Pulse", exact: true })
        .waitFor();
      await page.goBack();
      await page
        .getByRole("heading", { name: "Dashboard", exact: true })
        .waitFor();
      await page
        .getByRole("textbox", { name: "Search dashboard" })
        .fill("does-not-exist");
      await page
        .getByRole("heading", { name: "No matching projects" })
        .waitFor();
      await page.getByRole("heading", { name: "No matching skills" }).waitFor();
      await page.getByRole("textbox", { name: "Search dashboard" }).fill("");
      await page.reload();
      await page
        .getByRole("heading", { name: "Dashboard", exact: true })
        .waitFor();
      assert.equal(new URL(page.url()).searchParams.get("view"), "dashboard");
      await page.getByRole("button", { name: "Switch to dark theme" }).click();
      await capture("dashboard-dark-desktop.png");
      await page.getByRole("button", { name: "Switch to light theme" }).click();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.setViewportSize({width:375,height:812});
      await page.evaluate(()=>{document.documentElement.style.fontSize='20px';});
      const menu=page.getByRole('button',{name:'Menu',exact:true});
      assert(await menu.evaluate(node=>{
        const r=node.getBoundingClientRect();
        return [[r.left+2,r.top+2],[r.right-2,r.top+2],[r.left+2,r.bottom-2],[r.right-2,r.bottom-2],[(r.left+r.right)/2,(r.top+r.bottom)/2]]
          .every(([x,y])=>node.contains(document.elementFromPoint(x,y)));
      }),'Every part of Menu remains tappable with larger text');
      await page.getByRole('button',{name:'Menu',exact:true}).tap();
      await page.locator('.sidebar-mobile-open').waitFor({state:'visible'});
      await nav.getByRole('button',{name:'Agents',exact:true}).tap();
      await page.waitForURL(url=>url.searchParams.get('view')==='agents');
      await page.getByRole('button',{name:'Menu',exact:true}).tap();
      await nav.getByRole('button',{name:'Dashboard',exact:true}).tap();
      await page.getByRole('heading',{name:'Dashboard',exact:true}).waitFor();
      const mobileProjects=page.getByRole('region',{name:'Active projects',exact:true});
      const nextProject=mobileProjects.getByRole('button',{name:'Next active projects card',exact:true});
      const nextBox=await nextProject.boundingBox();assert(nextBox&&nextBox.width>=44&&nextBox.height>=44);
      await nextProject.tap();
      await mobileProjects.getByRole('status').filter({hasText:'Card 2 of'}).waitFor();
      await mobileProjects.locator('.dashboard-project-card').tap();
      await page.waitForURL(url=>Boolean(url.searchParams.get('project')));
      await page.getByRole('button',{name:'Menu',exact:true}).tap();
      await nav.getByRole('button',{name:'Dashboard',exact:true}).tap();
      await page.getByRole('heading',{name:'Dashboard',exact:true}).waitFor();
      await page.evaluate(()=>{document.documentElement.style.fontSize='';});
      await capture("dashboard-mobile-top.png");
      await projects.scrollIntoViewIfNeeded();
      await capture("dashboard-mobile-work.png");
      await page
        .getByRole("region", { name: "Community", exact: true })
        .scrollIntoViewIfNeeded();
      await capture("dashboard-mobile-community.png");
      assert(
        await page.evaluate(() => {
          const main = document.querySelector(".dashboard")!;
          return (
            document.documentElement.scrollWidth <= innerWidth &&
            main.scrollWidth <= main.clientWidth
          );
        }),
        "Mobile document/dashboard overflow",
      );
      await page.route("**/api/projects/dashboard", (route) =>
        route.fulfill({
          status: 502,
          contentType: "application/json",
          body: JSON.stringify({ error: "Test outage" }),
        }),
      );
      await page
        .getByRole("button", { name: "↻ Refresh", exact: true })
        .click();
      await page
        .getByRole("alert")
        .filter({ hasText: "Project metrics are unavailable" })
        .waitFor();
      assert.equal(
        await page.getByLabel("Finished tasks", { exact: true }).textContent(),
        "—",
      );
      await capture("dashboard-error-mobile.png");
      await page.unroute("**/api/projects/dashboard");
      await page.getByRole("button", { name: "Retry project metrics" }).click();
      await page.waitForFunction(
        () =>
          document.querySelector('[aria-label="Finished tasks"]')
            ?.textContent === "1",
      );
      // Archived engine channels remove records from every dashboard aggregate.
      for (const id of ids) {
        const value = await request(`/api/projects/${id}`);
        await request(`/api/channels/${value.channelId}/archive`, {});
      }
      await page.setViewportSize({ width: 1440, height: 1290 });
      await page
        .getByRole("button", { name: "↻ Refresh", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "Your first project starts here" })
        .waitFor();
      assert.equal(
        await page.getByLabel("Finished tasks", { exact: true }).textContent(),
        "0",
      );
      await capture("dashboard-empty-desktop.png");
      await page.reload();
      await page
        .getByRole("heading", { name: "Your first project starts here" })
        .waitFor();
      await page.setViewportSize({ width: 390, height: 844 });
      await capture("dashboard-empty-mobile.png");
      console.log(
        `PASS: dashboard real aggregates, access changes, task/community links, search, carousel keyboard, empty/error, reload, desktop/mobile/dark. Screenshots: ${screenshots}`,
      );
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
} finally {
  await server.close();
  await new Promise<void>((resolve) => backend.close(() => resolve()));
  product.store.close();
  engine.db.close();
  rmSync(dir, { recursive: true, force: true });
}
