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
