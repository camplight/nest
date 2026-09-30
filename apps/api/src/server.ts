import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { createApp } from './app';
import { attachEngineWebSocket } from './websocket';

const { app, orgops } = createApp();
const server = serve({fetch: app.fetch, port: Number(process.env.PORT ?? 8787)});
attachEngineWebSocket(server as Server, orgops.baseUrl);
