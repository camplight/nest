import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
/** A failure the agent may read: nothing was executed, or Nest answered with a status. */
class ConnectionError extends Error {}
const AMBIGUOUS =
  "Nest connection request failed. Check configuration and grants. Execution may have completed; do not automatically retry.";
/** What the agent sees: the reason when it is known and safe, otherwise the cautious generic message. */
export function failureMessage(error) {
  return error instanceof ConnectionError ? error.message : AMBIGUOUS;
}
const USAGE =
  "Use list, schema CONNECTION TOOL, or execute CONNECTION TOOL [--all] [--out FILE] with JSON arguments on stdin";
// Request arguments that take a next-page cursor, and response fields that carry one.
const PAGE_ARGUMENTS = ["cursor", "start_cursor", "page_token", "pageToken", "after"];
const NEXT_FIELDS = ["cursor", "next_cursor", "nextCursor", "next_page_token", "nextPageToken"];
const LIST_FIELDS = ["data", "items", "results", "values", "records", "elements", "messages", "files", "members"];
const MAX_PAGES = 50;
const skillDir = fileURLToPath(new URL("..", import.meta.url));

function options(argv) {
  const [action, connectionId, tool, ...rest] = argv;
  let all = false;
  let out;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--all" && !all) all = true;
    else if (rest[i] === "--out" && out === undefined && rest[i + 1]) out = rest[++i];
    else throw new ConnectionError(USAGE);
  }
  if (
    !["list", "schema", "execute"].includes(action) ||
    (action === "list" ? argv.length !== 1 : !connectionId || !tool) ||
    (action !== "execute" && (all || out !== undefined))
  )
    throw new ConnectionError(USAGE);
  if (all && out === undefined)
    throw new ConnectionError("--all needs --out FILE so a long list is saved instead of printed");
  return { action, connectionId, tool, all, out };
}
/** The provider's own response; Composio wraps it as `{data, successful, error}`. */
const body = (result) => (result && typeof result.data === "object" && result.data && "successful" in result ? result.data : result);
function nextCursor(page) {
  for (const holder of [page, page?.response_metadata, page?.meta, page?.pagination])
    for (const field of NEXT_FIELDS)
      if (typeof holder?.[field] === "string" && holder[field]) return holder[field];
  return null;
}
function listOf(page) {
  if (!page || typeof page !== "object") return null;
  for (const field of LIST_FIELDS) if (Array.isArray(page[field])) return page[field];
  const arrays = Object.values(page).filter(Array.isArray);
  return arrays.length === 1 ? arrays[0] : null;
}
/** Output files stay out of the skill directory, which holds the helper itself. */
function outputPath(file, cwd) {
  const path = resolve(cwd, file);
  const inside = relative(skillDir, path);
  if (!inside || (!inside.startsWith("..") && !isAbsolute(inside)))
    throw new ConnectionError("Save --out files in your workspace, not in the skill directory. Run the helper by its full path from your workspace.");
  return path;
}

export async function run(
  argv,
  env = process.env,
  transport = fetch,
  stdin = () => readFileSync(0, "utf8"),
  files = { cwd: process.cwd(), write: writeFileSync },
) {
  const { action, connectionId, tool, all, out } = options(argv);
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
  const target = out === undefined ? undefined : outputPath(out, files.cwd);
  async function request(kind, extra) {
    const response = await transport(
      new URL(`/api/integrations/skill/${kind === "list" ? "tools" : kind}`, base),
      {
        method: kind === "list" ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        ...(kind === "list"
          ? {}
          : { body: JSON.stringify({ connectionId, tool, ...extra }) }),
      },
    );
    if (!response.ok)
      throw new ConnectionError(
        `Nest refused the connection request (${response.status}). Check grants and app access; do not automatically retry execution.`,
      );
    return response.json();
  }
  if (action !== "execute") return request(action);
  if (!all) {
    const result = await request("execute", { arguments: args });
    if (target === undefined) return result;
    const text = JSON.stringify(result);
    files.write(target, text);
    return { saved: target, bytes: Buffer.byteLength(text), successful: result?.successful ?? null };
  }
  // Paging repeats the same read with the provider's next cursor, so only an
  // action that accepts a cursor argument may use --all.
  const schema = await request("schema");
  const accepted = Object.keys(schema?.inputParameters?.properties ?? {});
  const pageArgument = PAGE_ARGUMENTS.find((name) => accepted.includes(name));
  if (!pageArgument)
    throw new ConnectionError(`${tool} takes no page cursor, so --all cannot page it. Run it without --all.`);
  const items = [];
  const seen = new Set();
  let cursor = args[pageArgument] ?? null;
  let pages = 0;
  let complete = false;
  let last;
  const save = () => {
    files.write(target, JSON.stringify({ tool, pages, complete, items, last }));
    return { saved: target, pages, items: items.length, complete };
  };
  while (pages < MAX_PAGES) {
    let result;
    try {
      result = await request("execute", { arguments: cursor ? { ...args, [pageArgument]: cursor } : args });
    } catch (error) {
      if (!pages) throw error;
      save();
      throw new ConnectionError(`Page ${pages + 1} failed (${failureMessage(error)}). Saved ${items.length} items from ${pages} pages to ${target}; the list is incomplete.`);
    }
    pages++;
    const page = body(result);
    const list = listOf(page);
    if (result?.successful === false || !list) {
      if (pages === 1) {
        files.write(target, JSON.stringify(result));
        throw new ConnectionError(`${tool} returned an error or no list to page through. Its full response is saved to ${target}.`);
      }
      pages--;
      last = result;
      save();
      throw new ConnectionError(`Page ${pages + 1} returned an error or no list. Saved ${items.length} items from ${pages} pages to ${target}; the list is incomplete.`);
    }
    items.push(...list);
    // Keep the last page's other fields (totals, links) without its list.
    last = Object.fromEntries(Object.entries(page).filter(([, value]) => value !== list));
    const next = nextCursor(page);
    if (!next) { complete = true; break; }
    if (seen.has(next)) break;
    seen.add(next);
    cursor = next;
  }
  return save();
}
if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href)
  run(process.argv.slice(2))
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(failureMessage(error));
      process.exitCode = 1;
    });
