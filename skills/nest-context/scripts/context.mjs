import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
// Reads the home context of a chat this agent is in. Prints JSON, or streams one file to stdout.
export async function run(argv, env = process.env, transport = fetch, stdout = process.stdout) {
  const [action, channelId, fileId] = argv;
  if (
    !["read", "file"].includes(action) ||
    argv.length !== (action === "read" ? 2 : 3)
  )
    throw Error("Use read CHANNEL_ID, or file CHANNEL_ID FILE_ID");
  const base = new URL(
    env.NEST_CONTEXT_URL ??
      env.NEST_CONNECTIONS_URL ??
      env.NEST_API_URL ??
      "http://127.0.0.1:8787",
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
  const token = env.NEST_CONTEXT_TOKEN;
  if (!/^nest_context_[a-f0-9]{64}$/.test(token ?? ""))
    throw Error("Context access is not set up for this agent yet");
  const url = new URL(
    action === "read"
      ? "/api/context/agent"
      : `/api/context/agent/files/${encodeURIComponent(fileId)}`,
    base,
  );
  url.searchParams.set("channelId", channelId);
  const response = await transport(url, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw Error(`Nest context request failed (${response.status})`);
  if (action === "read") return response.json();
  await pipeline(Readable.fromWeb(response.body), stdout);
  return undefined;
}
if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href)
  run(process.argv.slice(2))
    .then((result) => {
      if (result !== undefined) console.log(JSON.stringify(result));
    })
    .catch((error) => {
      const status = /\((\d{3})\)$/.exec(error?.message ?? "")?.[1];
      console.error(
        `Nest context request failed${status ? ` (HTTP ${status})` : ""}. Continue without it; do not retry in a loop.`,
      );
      process.exitCode = 1;
    });
