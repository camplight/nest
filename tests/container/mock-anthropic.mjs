// Scripted stand-in for the Anthropic API, run inside the agent container by claude-code-agent.sh.
// Usage: node mock-anthropic.mjs <port> [log file]. See tests/container/README.md.
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const port = Number(process.argv[2] || 4010);
const logFile = process.argv[3] || "/tmp/mock-anthropic.jsonl";

const CHECK_COMMAND = "id; env | sort; cat /proc/1/environ | tr '\\0' '\\n'; ls -la /app/.nest-data /app/.nest-product /app/files; find / -name '*.sqlite' -not -path '/proc/*' 2>/dev/null; echo ok > check.txt; cat check.txt";

// The log holds the swapped credential, so only its writer (root in the check) may read it.
const record = (entry) => appendFileSync(logFile, `${JSON.stringify({ at: Date.now(), ...entry })}\n`, { mode: 0o600 });

const textOf = (content) => (typeof content === "string" ? content
  : Array.isArray(content) ? content.map((block) => (block?.type === "text" ? block.text : "")).join("") : "");

/** Decide the next assistant turn from the conversation so far. */
function scriptedReply(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  // Title, summary and other side calls carry no tools; they only need some text.
  if (!Array.isArray(body.tools) || body.tools.length === 0) return { blocks: [{ type: "text", text: "Container check" }], stop: "end_turn" };
  const results = messages.flatMap((message) => (message.role === "user" && Array.isArray(message.content)
    ? message.content.filter((block) => block?.type === "tool_result") : []));
  const prompt = messages.filter((message) => message.role === "user").map((message) => textOf(message.content)).join("\n");
  if (results.length === 0) {
    const command = /SLEEP/.test(prompt) ? "sleep 600" : CHECK_COMMAND;
    return {
      blocks: [
        { type: "text", text: "Checking the container." },
        { type: "tool_use", id: `toolu_check_${Date.now()}`, name: "Bash", input: { command, description: "Inspect the agent container" } },
      ],
      stop: "tool_use",
    };
  }
  return { blocks: [{ type: "text", text: `RESULT:\n${textOf(results.at(-1).content)}` }], stop: "end_turn" };
}

const usage = { input_tokens: 12, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

function messageOf(body, { blocks, stop }) {
  return { id: `msg_mock_${Date.now()}`, type: "message", role: "assistant", model: body.model || "claude-mock", content: blocks, stop_reason: stop, stop_sequence: null, usage: { ...usage, output_tokens: 20 } };
}

function streamMessage(res, body, reply) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "request-id": "req_mock" });
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const message = messageOf(body, reply);
  send("message_start", { message: { ...message, content: [], stop_reason: null, usage } });
  reply.blocks.forEach((block, index) => {
    if (block.type === "text") {
      send("content_block_start", { index, content_block: { type: "text", text: "" } });
      send("content_block_delta", { index, delta: { type: "text_delta", text: block.text } });
    } else {
      send("content_block_start", { index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
      send("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    }
    send("content_block_stop", { index });
  });
  send("message_delta", { delta: { stop_reason: reply.stop, stop_sequence: null }, usage: { output_tokens: 20 } });
  send("message_stop", {});
  res.end();
}

const json = (res, status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };

createServer((req, res) => {
  let raw = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => {
    const path = new URL(req.url, "http://mock").pathname;
    record({ method: req.method, path: req.url, authorization: req.headers.authorization ?? null, xApiKey: req.headers["x-api-key"] ?? null, beta: req.headers["anthropic-beta"] ?? null });
    if (req.method === "HEAD" || req.method === "GET") return json(res, 200, {});
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { return json(res, 400, { type: "error", error: { type: "invalid_request_error", message: "invalid JSON" } }); }
    if (path === "/v1/messages/count_tokens") return json(res, 200, { input_tokens: 12 });
    if (path === "/v1/messages") {
      const reply = scriptedReply(body);
      return body.stream ? streamMessage(res, body, reply) : json(res, 200, messageOf(body, reply));
    }
    // Unknown endpoints are logged above, so a new Claude Code release shows what it calls.
    return json(res, 404, { type: "error", error: { type: "not_found_error", message: `mock has no ${req.method} ${path}` } });
  });
}).listen(port, "127.0.0.1", () => console.log(`mock-anthropic listening on ${port}`));
