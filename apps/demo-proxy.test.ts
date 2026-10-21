import {afterEach, expect, it} from 'vitest';
import {mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer, request as httpRequest, type Server} from 'node:http';
import {preview, type PreviewServer} from 'vite';
import {demoProxy} from './demo-proxy';

let ui: PreviewServer | undefined;
let api: Server | undefined;
let root: string;
const oldPort = process.env.NEST_INTERNAL_API_PORT;
afterEach(async () => {
  await new Promise<void>(resolve => ui ? ui.httpServer.close(() => resolve()) : resolve());
  await new Promise<void>(resolve => api ? api.close(() => resolve()) : resolve());
  if (root) rmSync(root, {recursive:true,force:true});
  if (oldPort === undefined) delete process.env.NEST_INTERNAL_API_PORT;
  else process.env.NEST_INTERNAL_API_PORT = oldPort;
});
it('preview gates legacy symlinks, encoded paths and assets before static serving', async () => {
  root = mkdtempSync(join(tmpdir(), 'nest-demo-preview-'));
  mkdirSync(join(root, 'dist'));
  mkdirSync(join(root, 'demos', 'sample'), {recursive:true});
  writeFileSync(join(root, 'dist', 'index.html'), 'Nest UI');
  writeFileSync(join(root, 'demos', 'sample', 'index.html'), 'STATIC CONTENT MUST NOT LEAK');
  symlinkSync(join(root, 'demos'), join(root, 'dist', 'demo'));
  api = createServer((req,res) => {
    res.writeHead(req.headers.cookie === 'nest_session=test' ? 200 : 401, {'Cache-Control':'private, no-store'});
    res.end(req.headers.cookie === 'nest_session=test' ? 'Authenticated API' : 'Sign in');
  });
  await new Promise<void>(resolve => api!.listen(0, '127.0.0.1', resolve));
  process.env.NEST_INTERNAL_API_PORT = String((api.address() as {port:number}).port);
  ui = await preview({root, configFile:false, plugins:[demoProxy()], preview:{host:'127.0.0.1',port:0}});
  const port = (ui.httpServer.address() as {port:number}).port;
  const get = (path:string, cookie='') => new Promise<{status:number;body:string}>((resolve,reject) => {
    httpRequest({hostname:'127.0.0.1',port,path,headers:{cookie}}, res => {
      let body=''; res.on('data',chunk=>body+=chunk); res.on('end',()=>resolve({status:res.statusCode!,body}));
    }).on('error',reject).end();
  });
  for (const path of ['/demo/sample', '/demo/sample/', '/demo/sample/index.html', '/demo/sample.html', '/%64emo/sample/', '/demo%2fsample/', '//demo/sample/', '/demo/sample/asset.css']) {
    expect(await get(path)).toEqual({status:401,body:'Sign in'});
    expect(await get(path,'nest_session=test')).toEqual({status:200,body:'Authenticated API'});
  }
  expect((await get('/')).body).toContain('Nest UI');
});
