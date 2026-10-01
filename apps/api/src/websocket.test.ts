import { it, expect } from 'vitest';
import { serve } from '@hono/node-server';
import { createApp as createEngine } from '../../../vendor/orgops/apps/api/src/app';
import { createOrgOpsClient } from '@nest/orgops-client';
import { openProductDb } from '@nest/db';
import { createApp } from './app';
import { attachEngineWebSocket } from './websocket';
import { WebSocket } from 'ws';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

it('relays authenticated WebSocket messages to the real unchanged engine', async () => {
  const engine = createEngine({dbPath:':memory:',adminUser:'owner',adminPass:'password'});
  const upstream = serve({fetch:engine.app.fetch, port:0}); engine.injectWebSocket(upstream);
  await once(upstream,'listening');
  const store = openProductDb(':memory:');
  const client = createOrgOpsClient(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}`);
  const product = createApp({store,orgops:client});
  const server = serve({fetch:product.app.fetch,port:0}); attachEngineWebSocket(server as Server,client.baseUrl);
  await once(server,'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let ws: WebSocket | undefined;
  try {
    const anonymous = new WebSocket(url.replace('http:','ws:')+'/ws');
    await once(anonymous,'open');
    const denied = once(anonymous,'message'); anonymous.send(JSON.stringify({type:'subscribe',topic:'org:events'}));
    expect(JSON.parse(String((await denied)[0]))).toEqual({type:'error',message:'Unauthorized'});
    anonymous.close(); await once(anonymous,'close');
    const login = await fetch(url+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'owner',password:'password'})});
    ws = new WebSocket(url.replace('http:','ws:')+'/ws',{headers:{cookie:login.headers.get('set-cookie')!.split(';')[0]}});
    await once(ws,'open');
    const reply = once(ws,'message'); ws.send(JSON.stringify({type:'ping'}));
    expect(JSON.parse(String((await reply)[0]))).toEqual({type:'subscribed',topic:'pong'});
  } finally {
    if (ws) {ws.close(); await once(ws,'close');}
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await new Promise<void>(resolve=>upstream.close(()=>resolve()));
    store.close(); engine.db.close();
  }
}, 15000);
