import { readFileSync } from "node:fs";
export async function run(
  argv,
  env = process.env,
  transport = fetch,
  stdin = () => readFileSync(0, "utf8"),
) {
  const [action, connectionId, tool] = argv;
  if (
    !["list", "schema", "execute"].includes(action) ||
    argv.length !== (action === "list" ? 1 : 3)
  )
    throw Error(
      "Use list, schema CONNECTION TOOL, or execute CONNECTION TOOL with JSON arguments on stdin",
    );
  const base = new URL(
    env.NEST_CONNECTIONS_URL ?? env.NEST_API_URL ?? "http://127.0.0.1:8787",
  );
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/" ||
    !(
      base.protocol === "https:" ||
      (base.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))
    )
  )
    throw Error("Nest URL must be HTTPS or loopback HTTP");
  const token = env.NEST_CONNECTION_TOKEN;
  if (!/^nest_connection_[a-f0-9]{64}$/.test(token ?? ""))
    throw Error("Enable skill access in the owner’s Nest agent settings");
  let args;
  if (action === "execute") {
    args = JSON.parse(stdin());
    if (!args || typeof args !== "object" || Array.isArray(args))
      throw Error("Arguments must be a JSON object");
  }
  const response = await transport(
    new URL(
      `/api/integrations/skill/${action === "list" ? "tools" : action}`,
      base,
    ),
    {
      method: action === "list" ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      ...(action === "list"
        ? {}
        : {
            body: JSON.stringify({
              connectionId,
              tool,
              ...(action === "execute" ? { arguments: args } : {}),
            }),
          }),
    },
  );
  if (!response.ok)
    throw Error(
      `Nest connection request failed (${response.status}). Check grants and skill access; do not automatically retry execution.`,
    );
  return response.json();
}
if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href)
  run(process.argv.slice(2))
    .then((result) => console.log(JSON.stringify(result)))
    .catch(() => {
      console.error(
        "Nest connection request failed. Check configuration and grants. Execution may have completed; do not automatically retry.",
      );
      process.exitCode = 1;
    });
