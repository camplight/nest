// Per-turn credential proxy for Claude Code. See docs/CLAUDE_CODE_AGENT.md.
// Claude Code gets a random dummy credential and this proxy's URL; the real credential stays
// in the bridge process, which tool subprocesses running as another account cannot read.
import { createServer, request as httpRequest, Agent as HttpAgent } from "node:http";
import { request as httpsRequest, Agent as HttpsAgent } from "node:https";
import { randomUUID, timingSafeEqual } from "node:crypto";

// Never forwarded: the client's credential, and hop-by-hop headers that belong to one connection.
const DROPPED_REQUEST = new Set(["authorization", "x-api-key", "host", "connection", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade"]);
const DROPPED_RESPONSE = new Set(["connection", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade"]);

/** The agent's Anthropic credential; a subscription token wins over an API key. */
export function readCredential(env) {
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return { kind: "oauth", value: env.CLAUDE_CODE_OAUTH_TOKEN };
  if (env.ANTHROPIC_API_KEY) return { kind: "apiKey", value: env.ANTHROPIC_API_KEY };
  return undefined;
}

const same = (given, expected) => {
  const a = Buffer.from(String(given ?? "")), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

function forwardedHeaders(headers, credential) {
  // Headers named in Connection are hop-by-hop too.
  const named = new Set(String(headers.connection ?? "").split(",").map((name) => name.trim().toLowerCase()).filter(Boolean));
  const result = Object.fromEntries(Object.entries(headers).filter(([name]) => !DROPPED_REQUEST.has(name) && !named.has(name) && !name.startsWith("proxy-")));
  if (credential.kind === "oauth") result.authorization = `Bearer ${credential.value}`;
  else result["x-api-key"] = credential.value;
  return result;
}

const sendError = (res, status, type, message) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type, message } }));
};

/** Start a proxy on 127.0.0.1 for one turn; `close()` stops it and drops open connections. */
export async function startCredentialProxy({ credential, upstream = "https://api.anthropic.com" }) {
  const target = new URL(upstream);
  const secure = target.protocol === "https:";
  const send = secure ? httpsRequest : httpRequest;
  const agent = new (secure ? HttpsAgent : HttpAgent)({ keepAlive: true });
  const prefix = target.pathname.replace(/\/+$/, "");
  const dummy = `nest-proxy-${randomUUID()}`;

  const server = createServer((req, res) => {
    const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization ?? "")?.[1];
    if (!same(bearer, dummy) && !same(req.headers["x-api-key"], dummy)) {
      req.resume();
      sendError(res, 401, "authentication_error", "This proxy only serves the Claude Code turn that started it.");
      return;
    }
    const outgoing = send({
      protocol: target.protocol, hostname: target.hostname, port: target.port || undefined, agent,
      method: req.method, path: `${prefix}${req.url}`, headers: forwardedHeaders(req.headers, credential),
    }, (upstreamRes) => {
      const headers = Object.fromEntries(Object.entries(upstreamRes.headers).filter(([name]) => !DROPPED_RESPONSE.has(name)));
      res.writeHead(upstreamRes.statusCode, upstreamRes.statusMessage, headers);
      // Streamed as it arrives: Claude Code reads server-sent events.
      res.flushHeaders();
      upstreamRes.on("error", () => res.destroy());
      upstreamRes.pipe(res);
    });
    outgoing.on("error", () => {
      // The error may name the upstream host but never the credential; keep it out anyway.
      if (!res.headersSent) sendError(res, 502, "api_error", "The Anthropic API could not be reached.");
      else res.destroy();
    });
    req.on("error", () => outgoing.destroy());
    res.on("close", () => { if (!res.writableFinished) outgoing.destroy(); });
    req.pipe(outgoing);
  });

  server.listen(0, "127.0.0.1");
  await new Promise((done, fail) => { server.once("listening", done); server.once("error", fail); });
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    dummy,
    childEnv: credential.kind === "oauth"
      ? { ANTHROPIC_BASE_URL: url, CLAUDE_CODE_OAUTH_TOKEN: dummy }
      : { ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: dummy },
    close() {
      return new Promise((done) => {
        server.close(() => done());
        server.closeAllConnections();
        agent.destroy();
      });
    },
  };
}
