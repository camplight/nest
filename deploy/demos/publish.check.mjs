import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';

test('publisher preserves atomic publication behind auth and detects unexpected responses', async () => {
  const dir=await mkdtemp(join(tmpdir(),'demo-publish-'));
  const root=join(dir,'demos'); await mkdir(root);
  const source=join(dir,'index.html'); const html='<!doctype html><html><title>Fixture</title></html>';
  await writeFile(source,html);
  let status=401;
  const server=createServer((req,res)=>{res.writeHead(status,{'cache-control':'private, no-store','content-type':'text/html'});res.end(status===200?html:'Sign in');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const publish=slug=>new Promise(resolve=>{
    const child=spawn(process.execPath,[new URL('./publish.mjs',import.meta.url).pathname,source,slug],{env:{...process.env,NEST_DEMO_ROOT:root,NEST_DEMO_ORIGIN:`http://127.0.0.1:${server.address().port}`}});
    let output='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);child.on('exit',code=>resolve({code,output}));
  });
  try {
    const protectedResult=await publish('protected');assert.equal(protectedResult.code,0);assert.match(protectedResult.output,/authenticated browser verification still required/);
    assert.equal(await readFile(join(root,'protected','index.html'),'utf8'),html);
    status=200; assert.equal((await publish('legacy')).code,0);
    status=502; assert.equal((await publish('unavailable')).code,1);
  } finally {await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});
