import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { engineHeaders } from '@nest/orgops-client';

export function attachEngineWebSocket(server: Server, baseUrl: string) {
  const sockets = new WebSocketServer({noServer: true, maxPayload: 1024 * 1024});
  server.on('upgrade', (request, socket, head) => {
    if (new URL(request.url ?? '/', 'http://localhost').pathname !== '/ws') { socket.destroy(); return; }
    const headers = new Headers();
    for (const name of ['cookie', 'x-nest-runner-token', 'x-orgops-runner-token', 'origin']) {
      const value = request.headers[name];
      if (typeof value === 'string') headers.set(name, value);
    }
    const target = new URL('/ws', baseUrl); target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
    const upstream = new WebSocket(target, {headers: Object.fromEntries(engineHeaders(headers)), handshakeTimeout: 10_000, maxPayload: 1024 * 1024});
    let browser: WebSocket | undefined;
    socket.on('close', () => { if (upstream.readyState === WebSocket.CONNECTING || upstream.readyState === WebSocket.OPEN) upstream.terminate(); });
    upstream.on('error', () => { browser?.close(1011, 'Engine connection failed'); if (!browser) socket.destroy(); });
    upstream.on('open', () => sockets.handleUpgrade(request, socket, head, ws => {
      browser = ws;
      ws.on('message', (data, binary) => { if (upstream.readyState === WebSocket.OPEN) upstream.send(data, {binary}); });
      upstream.on('message', (data, binary) => { if (ws.readyState === WebSocket.OPEN) ws.send(data, {binary}); });
      ws.on('error', () => upstream.terminate());
      ws.on('close', () => upstream.close());
      upstream.on('close', () => ws.close(1001, 'Engine disconnected'));
    }));
  });
  return sockets;
}
