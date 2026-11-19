import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { createApp } from './app';
import { attachEngineWebSocket } from './websocket';

const { app, orgops, projectNaming, contextCompaction } = createApp();
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
