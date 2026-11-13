import { test, expect } from "vitest";
import { run } from "../skills/nest-connections/scripts/connections.mjs";
import { pack, verifyPackage } from "./community.mjs";
const env = {
  NEST_CONNECTIONS_URL: "https://nest.example",
  NEST_CONNECTION_TOKEN: "nest_connection_" + "a".repeat(64),
};
test("connection skill is a valid private community package without credentials", () => {
  const value = pack("skills/nest-connections");
  expect(verifyPackage(value).manifest.name).toBe("nest-connections");
  expect(JSON.stringify(value)).not.toContain(env.NEST_CONNECTION_TOKEN);
});
test("skill sends explicit tool arguments and credentials only to configured Nest", async () => {
  let calls = 0;
  const result = await run(
    ["execute", "connection-id", "TRELLO_GET_BOARDS"],
    env,
    async (url, init) => {
      calls++;
      expect(String(url)).toBe(
        "https://nest.example/api/integrations/skill/execute",
      );
      expect(init.headers.authorization).toBe(
        "Bearer " + env.NEST_CONNECTION_TOKEN,
      );
      expect(init.redirect).toBe("error");
      expect(JSON.parse(init.body)).toEqual({
        connectionId: "connection-id",
        tool: "TRELLO_GET_BOARDS",
        arguments: { board: "example" },
      });
      return Response.json({ data: "ok" });
    },
    () => '{"board":"example"}',
  );
  expect(result).toEqual({ data: "ok" });
  expect(calls).toBe(1);
});
test("skill fails closed for unsafe origins, missing credentials and ambiguous action failures", async () => {
  for (const base of [
    "http://remote.example",
    "https://user:pass@nest.example",
    "https://nest.example/path",
    "https://nest.example?key=value",
  ])
    await expect(
      run(["list"], { ...env, NEST_CONNECTIONS_URL: base }),
    ).rejects.toThrow();
  await expect(
    run(["list"], { NEST_CONNECTIONS_URL: env.NEST_CONNECTIONS_URL }),
  ).rejects.toThrow();
  let calls = 0;
  await expect(
    run(
      ["execute", "id", "TOOL"],
      env,
      async () => {
        calls++;
        throw Error("timeout");
      },
      () => "{}",
    ),
  ).rejects.toThrow();
  expect(calls).toBe(1);
  await expect(
    run(
      ["execute", "id", "TOOL"],
      env,
      async () => {
        throw Error("must not reach transport");
      },
      () => "[]",
    ),
  ).rejects.toThrow("Arguments must");
});
test("the agent sees why a call failed, except when the request may have run", async () => {
  const { failureMessage } = await import("../skills/nest-connections/scripts/connections.mjs");
  const reason = async (...args) => failureMessage(await run(...args).then(() => null, (error) => error));
  // App access off: no request was sent, so the owner's fix is named.
  expect(await reason(["list"], { NEST_CONNECTIONS_URL: env.NEST_CONNECTIONS_URL })).toBe(
    "App access is off for this agent. Ask your owner to click Enable app access on the agent's Connected apps page in Nest.",
  );
  // Nest answered and refused: the status is shown.
  expect(await reason(["list"], env, async () => Response.json({}, { status: 403 }))).toBe(
    "Nest refused the connection request (403). Check grants and app access; do not automatically retry execution.",
  );
  // The request may have reached the app: stay cautious and say nothing more specific.
  expect(await reason(["execute", "id", "TOOL"], env, async () => { throw Error("secret-detail timeout"); }, () => "{}")).toBe(
    "Nest connection request failed. Check configuration and grants. Execution may have completed; do not automatically retry.",
  );
});
test("--all follows the provider's cursor and saves the whole list to a file", async () => {
  const written = {};
  const files = { cwd: "/workspace", write: (path, text) => { written[path] = JSON.parse(text); } };
  const pages = {
    "": { cursor: "c2", data: [{ id: 1 }, { id: 2 }], total: 5 },
    c2: { cursor: "c3", data: [{ id: 3 }, { id: 4 }], total: 5 },
    c3: { data: [{ id: 5 }], total: 5 },
  };
  const sent = [];
  const result = await run(
    ["execute", "conn", "MIRO_GET_BOARD_ITEMS", "--all", "--out", "items.json"],
    env,
    async (url, init) => {
      const request = JSON.parse(init.body);
      if (String(url).endsWith("/schema"))
        return Response.json({ inputParameters: { properties: { board_id: {}, limit: {}, cursor: {} } } });
      sent.push(request.arguments);
      return Response.json({ data: pages[request.arguments.cursor ?? ""], successful: true, error: null });
    },
    () => '{"board_id":"b","limit":2}',
    files,
  );
  expect(sent).toEqual([
    { board_id: "b", limit: 2 },
    { board_id: "b", limit: 2, cursor: "c2" },
    { board_id: "b", limit: 2, cursor: "c3" },
  ]);
  // Only a short summary reaches the agent; the items go to the file.
  expect(result).toEqual({ saved: "/workspace/items.json", pages: 3, items: 5, complete: true });
  expect(written["/workspace/items.json"]).toEqual({
    tool: "MIRO_GET_BOARD_ITEMS", pages: 3, complete: true,
    items: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }], last: { total: 5 },
  });
});
test("--all never repeats an action that takes no cursor, and a failed page keeps what was saved", async () => {
  const written = {};
  const files = { cwd: "/workspace", write: (path, text) => { written[path] = JSON.parse(text); } };
  let executed = 0;
  await expect(run(["execute", "conn", "MIRO_CREATE_STICKY", "--all", "--out", "x.json"], env, async (url) => {
    if (String(url).endsWith("/schema")) return Response.json({ inputParameters: { properties: { board_id: {}, content: {} } } });
    executed++;
    return Response.json({});
  }, () => "{}", files)).rejects.toThrow("takes no page cursor");
  expect(executed).toBe(0);
  const { failureMessage } = await import("../skills/nest-connections/scripts/connections.mjs");
  let attempts = 0;
  const error = await run(["execute", "conn", "LIST", "--all", "--out", "x.json"], { ...env, NEST_CONNECTIONS_RETRY_MS: "0" }, async (url, init) => {
    if (String(url).endsWith("/schema")) return Response.json({ inputParameters: { properties: { cursor: {} } } });
    if (JSON.parse(init.body).arguments.cursor) { attempts++; throw Error("timeout"); }
    return Response.json({ data: { items: [1, 2], next_cursor: "n" }, successful: true });
  }, () => "{}", files).catch((e) => e);
  expect(failureMessage(error)).toContain("Saved 2 items from 1 pages to /workspace/x.json; the list is incomplete.");
  expect(written["/workspace/x.json"]).toMatchObject({ complete: false, items: [1, 2] });
  expect(attempts).toBe(2);
});
test("--all asks for the largest page the tool allows and retries a failed page once", async () => {
  const files = { cwd: "/workspace", write: () => {} };
  const fast = { ...env, NEST_CONNECTIONS_RETRY_MS: "0" };
  const sizes = async (limit) => {
    const sent = [];
    await run(["execute", "conn", "LIST", "--all", "--out", "x.json"], fast, async (url, init) => {
      if (String(url).endsWith("/schema"))
        return Response.json({ inputParameters: { properties: { cursor: {}, ...(limit ? { limit } : {}) } } });
      sent.push(JSON.parse(init.body).arguments);
      return Response.json({ data: { data: [1] }, successful: true });
    }, () => "{}", files);
    return sent;
  };
  expect(await sizes({ type: "integer", maximum: 100 })).toEqual([{ limit: 100 }]);
  expect(await sizes({ type: "integer", maximum: 5000 })).toEqual([{ limit: 200 }]);
  expect(await sizes({ type: "integer", description: "Number of items per page. Minimum 10, maximum 50." })).toEqual([{ limit: 50 }]);
  expect(await sizes({ type: "integer" })).toEqual([{ limit: 50 }]);
  expect(await sizes(undefined)).toEqual([{}]);

  // A tool that rejects the larger page falls back to its own default; a thrown page is asked for again.
  const sent = [];
  let failedOnce = false;
  const written = {};
  const result = await run(["execute", "conn", "LIST", "--all", "--out", "x.json"], fast, async (url, init) => {
    if (String(url).endsWith("/schema")) return Response.json({ inputParameters: { properties: { cursor: {}, limit: {} } } });
    const args = JSON.parse(init.body).arguments;
    sent.push(args);
    if (args.limit) return Response.json({ data: null, successful: false, error: "limit too large" });
    if (args.cursor && !failedOnce) { failedOnce = true; throw Error("502"); }
    return Response.json({ data: { data: [args.cursor ?? "first"], ...(args.cursor ? {} : { cursor: "next" }) }, successful: true });
  }, () => "{}", { cwd: "/workspace", write: (path, text) => { written[path] = JSON.parse(text); } });
  expect(sent).toEqual([{ limit: 50 }, {}, { cursor: "next" }, { cursor: "next" }]);
  expect(result).toEqual({ saved: "/workspace/x.json", pages: 2, items: 2, complete: true });
  expect(written["/workspace/x.json"]).not.toHaveProperty("pageSize");
});
test("--out writes one result to a file and stays out of the skill directory", async () => {
  const written = {};
  const files = { cwd: "/workspace", write: (path, text) => { written[path] = text; } };
  const transport = async () => Response.json({ data: { big: "x".repeat(100) }, successful: true });
  expect(await run(["execute", "c", "T", "--out", "r.json"], env, transport, () => "{}", files)).toEqual({ saved: "/workspace/r.json", bytes: 137, successful: true });
  const skillDir = new URL("../skills/nest-connections/", import.meta.url).pathname;
  await expect(run(["execute", "c", "T", "--out", "r.json"], env, transport, () => "{}", { ...files, cwd: skillDir })).rejects.toThrow("not in the skill directory");
  await expect(run(["execute", "c", "T", "--all"], env, transport, () => "{}", files)).rejects.toThrow("--all needs --out");
  await expect(run(["list", "--all"], env, transport, () => "{}", files)).rejects.toThrow("Use list");
});
