import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,statSync,symlinkSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseEnv} from 'node:util';
import {configureLiveKit} from './configure-livekit.mjs';
test('configuration entrypoint executes through a release symlink',()=>{
 const root=mkdtempSync(join(tmpdir(),'nest-livekit-entry-'));
 try{
  writeFileSync(join(root,'runtime.env'),'');
  const entry=join(root,'configure.mjs');symlinkSync(new URL('./configure-livekit.mjs',import.meta.url),entry);
  const result=spawnSync(process.execPath,[entry,root,'http://127.0.0.1:8080'],{encoding:'utf8',timeout:5000});
  assert.equal(result.status,0,result.stderr);
  assert.equal(parseEnv(readFileSync(join(root,'runtime.env'),'utf8')).NEST_ENABLE_LIVEKIT,'1');
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('managed SFU provisioning preserves private environment and reuses credentials',()=>{
 const root=mkdtempSync(join(tmpdir(),'nest-livekit-'));
 try{
  const original='NEST_RUNNER_TOKEN="synthetic"\nNEST_GOOGLE_CLIENT_SECRET="first\nsecond"\n';
  writeFileSync(join(root,'runtime.env'),original,{mode:0o600});
  const previousMask=process.umask(0o077);
  try { assert.equal(configureLiveKit(root,'nest.example.test').url,'wss://nest.example.test:8443'); }
  finally { process.umask(previousMask); }
  const contents=readFileSync(join(root,'runtime.env'),'utf8'),env=parseEnv(contents);
  assert(contents.startsWith(original));assert.equal(env.NEST_GOOGLE_CLIENT_SECRET,'first\nsecond');
  assert(env.LIVEKIT_API_SECRET.length>=32);assert.equal(env.ORGOPS_VOICE_BROKER,'livekit');
  const config=JSON.parse(readFileSync(join(root,'livekit.yaml'),'utf8'));
  assert.equal(config.keys[env.LIVEKIT_API_KEY],env.LIVEKIT_API_SECRET);assert.equal(config.rtc.udp_port,7882);
  configureLiveKit(root,'nest.example.test');assert.equal(readFileSync(join(root,'runtime.env'),'utf8'),contents);
  assert(!readFileSync(join(root,'caddy.d/livekit.caddy'),'utf8').includes(env.LIVEKIT_API_SECRET));
  assert.equal(statSync(join(root,'caddy.d')).mode&0o777,0o755);
  assert.equal(statSync(join(root,'caddy.d/livekit.caddy')).mode&0o777,0o644);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('rehearsals use loopback; an existing external SFU is never silently replaced',()=>{
 const root=mkdtempSync(join(tmpdir(),'nest-livekit-'));
 try{
  writeFileSync(join(root,'runtime.env'),'');configureLiveKit(root,'http://127.0.0.1:8080');
  assert.equal(parseEnv(readFileSync(join(root,'runtime.env'),'utf8')).LIVEKIT_URL,'ws://127.0.0.1:7880');
  assert.equal(readFileSync(join(root,'caddy.d/livekit.caddy'),'utf8'),'');
  const original="LIVEKIT_URL='wss://external.example.test'\n";writeFileSync(join(root,'runtime.env'),original);
  assert.throws(()=>configureLiveKit(root,'nest.example.test'),/operator migration/);
  assert.equal(readFileSync(join(root,'runtime.env'),'utf8'),original);
 }finally{rmSync(root,{recursive:true,force:true});}
});
