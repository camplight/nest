import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { createApp } from './app';
import { attachEngineWebSocket } from './websocket';

const { app, orgops, projectNaming } = createApp();
const server = serve({fetch: app.fetch, port: Number(process.env.PORT ?? 8787), hostname: process.env.NEST_BIND_HOST});
attachEngineWebSocket(server as Server, orgops.baseUrl);

// No agent turn, browser tab or runner heartbeat is required for naming.
const namingTimer=setInterval(()=>{void projectNaming.tick();},5000);
namingTimer.unref();
void projectNaming.tick();
server.on('close',()=>clearInterval(namingTimer));
