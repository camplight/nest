import { chromium } from "playwright";
import assert from "node:assert/strict";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createApp as createEngine } from "../../vendor/orgops/apps/api/src/app";
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
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1290 },
      reducedMotion: "no-preference",
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
