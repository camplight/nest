import { readFileSync } from "node:fs";
/** A failure the agent may read: nothing was executed, or Nest answered with a status. */
class ConnectionError extends Error {}
const AMBIGUOUS =
  "Nest connection request failed. Check configuration and grants. Execution may have completed; do not automatically retry.";
/** What the agent sees: the reason when it is known and safe, otherwise the cautious generic message. */
export function failureMessage(error) {
  return error instanceof ConnectionError ? error.message : AMBIGUOUS;
}
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
    throw new ConnectionError(
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
    throw new ConnectionError("Nest URL must be HTTPS or loopback HTTP");
  const token = env.NEST_CONNECTION_TOKEN;
  if (!/^nest_connection_[a-f0-9]{64}$/.test(token ?? ""))
    throw new ConnectionError(
      "App access is off for this agent. Ask your owner to click Enable app access on the agent's Connected apps page in Nest.",
    );
  let args;
  if (action === "execute") {
    try {
      args = JSON.parse(stdin());
    } catch {
      throw new ConnectionError("Arguments must be a JSON object on stdin");
    }
    if (!args || typeof args !== "object" || Array.isArray(args))
      throw new ConnectionError("Arguments must be a JSON object");
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
    throw new ConnectionError(
      `Nest refused the connection request (${response.status}). Check grants and app access; do not automatically retry execution.`,
    );
  return response.json();
}
if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href)
  run(process.argv.slice(2))
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(failureMessage(error));
      process.exitCode = 1;
    });
