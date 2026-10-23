import {it, expect, describe, afterEach} from 'vitest';
import {createServer, request} from 'node:http';
import {once} from 'node:events';
import {readCredential, startCredentialProxy} from './claude-code-proxy.mjs';

const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

/** A local stand-in for api.anthropic.com that records what reached it. */
async function fakeUpstream(handler = (_req, res) => { res.writeHead(200, {'content-type':'application/json', 'x-upstream':'yes'}); res.end('{"ok":true}'); }) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk; });
    req.on('end', () => { seen.push({method:req.method, url:req.url, headers:req.headers, body}); handler(req, res); });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanup.push(() => { server.closeAllConnections(); return new Promise(done => server.close(done)); });
  return {url:`http://127.0.0.1:${server.address().port}`, seen};
}

async function proxyFor(credential, upstream) {
  const proxy = await startCredentialProxy({credential, upstream});
  cleanup.push(() => proxy.close());
  return proxy;
}

function send(url, {method = 'POST', path = '/v1/messages?beta=true', headers = {}, body} = {}) {
  return new Promise((done, fail) => {
    const req = request(`${url}${path}`, {method, headers}, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => done({status:res.statusCode, headers:res.headers, body:text}));
    });
    req.on('error', fail); req.end(body);
  });
}

describe('credential proxy', () => {
  it('swaps the dummy bearer for the real oauth token and keeps other headers', async () => {
    const upstream = await fakeUpstream();
    const proxy = await proxyFor({kind:'oauth', value:'real-oauth'}, upstream.url);
    expect(proxy.dummy).toMatch(/^nest-proxy-[0-9a-f-]{36}$/);
    expect(proxy.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(proxy.childEnv).toEqual({ANTHROPIC_BASE_URL:proxy.url, CLAUDE_CODE_OAUTH_TOKEN:proxy.dummy});
    const reply = await send(proxy.url, {headers:{authorization:`Bearer ${proxy.dummy}`, 'anthropic-beta':'oauth-2025-04-20', 'content-type':'application/json'}, body:'{"model":"x"}'});
    expect(reply).toMatchObject({status:200, body:'{"ok":true}', headers:{'x-upstream':'yes'}});
    const [seen] = upstream.seen;
    expect(seen).toMatchObject({method:'POST', url:'/v1/messages?beta=true', body:'{"model":"x"}'});
    expect(seen.headers).toMatchObject({authorization:'Bearer real-oauth', 'anthropic-beta':'oauth-2025-04-20', 'content-type':'application/json'});
    expect(seen.headers).not.toHaveProperty('x-api-key');
    expect(JSON.stringify(seen)).not.toContain(proxy.dummy);
    const second = await proxyFor({kind:'oauth', value:'real-oauth'}, upstream.url);
    expect(second.dummy).not.toBe(proxy.dummy);
  });

  it('swaps x-api-key for an API key credential', async () => {
    const upstream = await fakeUpstream();
    const proxy = await proxyFor({kind:'apiKey', value:'sk-ant-real'}, upstream.url);
    expect(proxy.childEnv).toEqual({ANTHROPIC_BASE_URL:proxy.url, ANTHROPIC_API_KEY:proxy.dummy});
    expect((await send(proxy.url, {headers:{'x-api-key':proxy.dummy}})).status).toBe(200);
    expect(upstream.seen[0].headers['x-api-key']).toBe('sk-ant-real');
    expect(upstream.seen[0].headers).not.toHaveProperty('authorization');
  });

  it('streams SSE chunks before the upstream response ends', async () => {
    let release;
    const released = new Promise(done => { release = done; });
    const upstream = await fakeUpstream(async (_req, res) => {
      res.writeHead(200, {'content-type':'text/event-stream'});
      res.write('event: message_start\ndata: {}\n\n');
      await released;
      res.end('event: message_stop\ndata: {}\n\n');
    });
    const proxy = await proxyFor({kind:'oauth', value:'real-oauth'}, upstream.url);
    const chunks = [];
    await new Promise((done, fail) => {
      const req = request(`${proxy.url}/v1/messages`, {method:'POST', headers:{authorization:`Bearer ${proxy.dummy}`}}, res => {
        res.setEncoding('utf8');
        res.on('data', chunk => { chunks.push(chunk); if (chunks.length === 1) release(); });
        res.on('end', done);
      });
      req.on('error', fail); req.end();
    });
    expect(chunks[0]).toBe('event: message_start\ndata: {}\n\n');
    expect(chunks.join('')).toContain('message_stop');
  });

  it('rejects requests carrying another credential and never forwards them', async () => {
    const upstream = await fakeUpstream();
    const proxy = await proxyFor({kind:'oauth', value:'real-oauth'}, upstream.url);
    for (const headers of [{authorization:'Bearer something-else'}, {'x-api-key':'nest-proxy-guess'}, {authorization:proxy.dummy}]) {
      const reply = await send(proxy.url, {headers});
      expect(reply.status).toBe(401);
      expect(JSON.parse(reply.body)).toMatchObject({type:'error', error:{type:'authentication_error'}});
      expect(reply.body).not.toContain('real-oauth');
    }
    expect(upstream.seen).toHaveLength(0);
  });

  it('surfaces an upstream 401 directly and quickly', async () => {
    const upstream = await fakeUpstream((_req, res) => { res.writeHead(401, {'content-type':'application/json'}); res.end('{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'); });
    const proxy = await proxyFor({kind:'apiKey', value:'sk-ant-revoked'}, upstream.url);
    const started = Date.now();
    const reply = await send(proxy.url, {headers:{'x-api-key':proxy.dummy}});
    expect(Date.now() - started).toBeLessThan(1000);
    expect(reply.status).toBe(401);
    expect(JSON.parse(reply.body).error.type).toBe('authentication_error');
  });

  it('forwards non-messages paths such as HEAD /api/hello', async () => {
    const upstream = await fakeUpstream((_req, res) => { res.writeHead(204); res.end(); });
    const proxy = await proxyFor({kind:'oauth', value:'real-oauth'}, upstream.url);
    expect((await send(proxy.url, {method:'HEAD', path:'/api/hello', headers:{authorization:`Bearer ${proxy.dummy}`}})).status).toBe(204);
    expect(upstream.seen).toMatchObject([{method:'HEAD', url:'/api/hello'}]);
  });

  it('passes credential-free requests such as Claude Code\'s HEAD /api/hello through without adding the credential', async () => {
    const upstream = await fakeUpstream((_req, res) => { res.writeHead(200); res.end(); });
    const proxy = await proxyFor({kind:'oauth', value:'real-oauth'}, upstream.url);
    expect((await send(proxy.url, {method:'HEAD', path:'/api/hello'})).status).toBe(200);
    expect(upstream.seen).toMatchObject([{method:'HEAD', url:'/api/hello'}]);
    expect(upstream.seen[0].headers).not.toHaveProperty('authorization');
    expect(upstream.seen[0].headers).not.toHaveProperty('x-api-key');
  });

  it('keeps a path prefix of the upstream URL', async () => {
    const upstream = await fakeUpstream();
    const proxy = await proxyFor({kind:'oauth', value:'real-oauth'}, `${upstream.url}/anthropic/`);
    await send(proxy.url, {headers:{authorization:`Bearer ${proxy.dummy}`}});
    expect(upstream.seen[0].url).toBe('/anthropic/v1/messages?beta=true');
  });

  it('returns 502 when the upstream is unreachable', async () => {
    const upstream = await fakeUpstream();
    const port = new URL(upstream.url).port;
    await cleanup.pop()();
    const proxy = await proxyFor({kind:'oauth', value:'real-oauth'}, `http://127.0.0.1:${port}`);
    const reply = await send(proxy.url, {headers:{authorization:`Bearer ${proxy.dummy}`}});
    expect(reply.status).toBe(502);
    expect(JSON.parse(reply.body)).toMatchObject({type:'error', error:{type:'api_error'}});
    expect(reply.body).not.toContain('real-oauth');
  });

  it('close() ends the server', async () => {
    const upstream = await fakeUpstream((_req, res) => { res.writeHead(200, {'content-type':'text/event-stream'}); res.write('data: {}\n\n'); });
    const proxy = await startCredentialProxy({credential:{kind:'oauth', value:'real-oauth'}, upstream:upstream.url});
    // An open streaming response must not keep close() waiting.
    const open = new Promise(done => {
      request(`${proxy.url}/v1/messages`, {method:'POST', headers:{authorization:`Bearer ${proxy.dummy}`}}, res => { res.on('data', () => done(res)); res.on('error', () => {}); })
        .on('error', () => {}).end();
    });
    const response = await open;
    const closed = new Promise(done => response.on('close', done));
    await proxy.close();
    await closed;
    await expect(send(proxy.url, {headers:{authorization:`Bearer ${proxy.dummy}`}})).rejects.toThrow(/ECONNREFUSED/);
  });

  it('readCredential prefers CLAUDE_CODE_OAUTH_TOKEN', () => {
    expect(readCredential({CLAUDE_CODE_OAUTH_TOKEN:'oauth', ANTHROPIC_API_KEY:'key'})).toEqual({kind:'oauth', value:'oauth'});
    expect(readCredential({ANTHROPIC_API_KEY:'key'})).toEqual({kind:'apiKey', value:'key'});
    expect(readCredential({CLAUDE_CODE_OAUTH_TOKEN:'', PATH:'/bin'})).toBeUndefined();
  });
});
