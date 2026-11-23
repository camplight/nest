import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { createApp } from './app';
import { attachEngineWebSocket } from './websocket';

const { app, orgops, projectNaming, flows, contextCompaction } = createApp();
const server = serve({fetch: app.fetch, port: Number(process.env.PORT ?? 8787), hostname: process.env.NEST_BIND_HOST});
attachEngineWebSocket(server as Server, orgops.baseUrl);

// No agent turn, browser tab or runner heartbeat is required for naming.
const namingTimer=setInterval(()=>{void projectNaming.tick();},5000);
namingTimer.unref();
void projectNaming.tick();
// Long chats of agents set to "Full history, summarized when long" (see docs/SPEC.md).
const compactionTimer=setInterval(()=>{void contextCompaction.tick();},15000);
compactionTimer.unref();
server.on('close',()=>{clearInterval(namingTimer);clearInterval(compactionTimer);});

// Hand-offs between linked chats: a 15 s catch-up, woken sooner by the engine socket. Flag on only.
if (flows.enabled) {
  const flowsTimer = setInterval(() => { void flows.tick(); }, 15_000);
  flowsTimer.unref();
  const watcher = flows.watch(orgops.baseUrl);
  void flows.tick();
  server.on('close', () => { clearInterval(flowsTimer); watcher?.close(); });
}
