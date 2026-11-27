// Local/CI only. Synthetic OOM is confined to a disposable 64 MiB container on cgroup v2.
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const docker=(args,options={})=>execFileSync('docker',args,{encoding:'utf8',timeout:30_000,...options}).trim();
const defaults={...process.env,NEST_MEMORY_LIMIT:'1536m',NEST_MEMORY_SWAP_LIMIT:'2048m',NEST_CPU_LIMIT:'0.80',NEST_PIDS_LIMIT:'384'};
const config=env=>{
 const root=mkdtempSync(join(tmpdir(),'nest-compose-check-'));
 try{
  writeFileSync(join(root,'compose.yaml'),readFileSync('deploy/compose.yaml'));
  writeFileSync(join(root,'.env'),'');
  return JSON.parse(docker(['compose','--env-file','/dev/null','-f',join(root,'compose.yaml'),'config','--format','json'],{env})).services.nest;
 }finally{rmSync(root,{recursive:true,force:true});}
};
const service=config(defaults);
assert.equal(Number(service.mem_limit),1536*1024**2);
assert.equal(Number(service.memswap_limit),2048*1024**2);
assert.equal(Number(service.cpus),0.8);
assert.equal(Number(service.pids_limit),384);
assert.equal(service.restart,'unless-stopped');
assert.deepEqual(service.volumes.map(v=>v.target).sort(),['/app/.nest-data','/app/.nest-product','/app/files'].sort());
assert.equal(service.logging.driver,'local');
const changed=config({...defaults,NEST_MEMORY_LIMIT:'2g',NEST_MEMORY_SWAP_LIMIT:'3g',NEST_CPU_LIMIT:'1.5',NEST_PIDS_LIMIT:'512'});
assert.equal(Number(changed.mem_limit),2*1024**3);assert.equal(Number(changed.memswap_limit),3*1024**3);assert.equal(Number(changed.cpus),1.5);assert.equal(Number(changed.pids_limit),512);
console.log('PASS: Compose budgets, overrides, restart policy and durable volume mounts');

const suffix=randomUUID();const container='nest-resource-check-'+suffix;const volume=container+'-data';
const image=process.argv[2]??'nest:check';
// Observe the kernel counter before the cgroup is torn down. Docker's event
// history can miss a short-lived OOM even when the restart succeeds.
const fixture=`
if [ -f /data/sentinel ]; then
  test -s /data/oom-kill
  echo recovered
  exec node -e 'setInterval(() => {}, 1000)'
fi
read_oom_kill() {
  awk '$1 == "oom_kill" { print $2; found = 1 } END { exit !found }' /sys/fs/cgroup/memory.events
}
before=$(read_oom_kill)
printf '%s' durable-fixture > /data/sentinel
status=0
# Keep V8's heap limit above the cgroup limit so the kernel kills the allocator.
node --max-old-space-size=256 -e 'const blocks=[];while(true)blocks.push(Buffer.alloc(4*1024*1024,1))' || status=$?
after=$(read_oom_kill)
echo "allocator exit=$status; kernel oom_kill: $before -> $after"
[ "$status" -eq 137 ] && [ "$after" -gt "$before" ] || exit 1
printf '%s %s\\n' "$before" "$after" > /data/oom-kill
exit "$status"
`;
try{
 docker(['run','--detach','--name',container,'--network','none','--cgroupns','private','--memory','64m','--memory-swap','64m','--cpus','0.25','--pids-limit','32','--restart','on-failure:1','--mount',`type=volume,source=${volume},target=/data`,'--entrypoint','sh',image,'-ec',fixture]);
 let recovered=false;
 for(let attempt=0;attempt<40;attempt++){
  const [info]=JSON.parse(docker(['inspect',container]));
  if(info.RestartCount>=1&&!info.State.Running&&info.State.Status==='exited')break;
  if(info.RestartCount>=1&&info.State.Running&&docker(['logs',container]).includes('recovered')){recovered=true;break;}
  await new Promise(resolve=>setTimeout(resolve,500));
 }
 if(!recovered)console.error('Bounded fixture logs:',docker(['logs',container]));
 assert.ok(recovered,'Bounded fixture must record a kernel cgroup OOM kill and restart');
 const [info]=JSON.parse(docker(['inspect',container]));
 assert.equal(info.HostConfig.Memory,64*1024**2);assert.equal(info.HostConfig.MemorySwap,64*1024**2);assert.equal(info.HostConfig.PidsLimit,32);assert.equal(info.HostConfig.NanoCpus,250_000_000);
 assert.equal(docker(['exec',container,'cat','/data/sentinel']),'durable-fixture');
 const [before,after]=docker(['exec',container,'cat','/data/oom-kill']).split(' ').map(Number);
 assert.ok(after>before,'The kernel cgroup oom_kill counter must increase');
 console.log(`PASS: 64 MiB cgroup recorded an OOM kill (${before} -> ${after}); Docker restarted and durable data survived`);
}finally{
 try{docker(['rm','--force','--volumes',container]);}catch{}
 try{docker(['volume','rm',volume]);}catch{}
}

const healthContainer=container+'-health';const healthVolume=volume+'-health';
const healthFixture=`const fs=require('node:fs');if(fs.existsSync('/data/sentinel'))fs.writeFileSync('/data/healthy','yes');else fs.writeFileSync('/data/sentinel','durable-fixture');setInterval(()=>{},1000);`;
async function waitHealth(expected){for(let attempt=0;attempt<30;attempt++){const [info]=JSON.parse(docker(['inspect',healthContainer]));if(info.State.Health?.Status===expected)return info;await new Promise(resolve=>setTimeout(resolve,500));}throw Error('Fixture health did not become '+expected);}
try{
 docker(['run','--detach','--name',healthContainer,'--network','none','--memory','64m','--memory-swap','64m','--pids-limit','32','--cpus','0.25','--health-cmd','test -f /data/healthy','--health-start-period','1s','--health-interval','1s','--health-timeout','1s','--health-retries','1','--mount',`type=volume,source=${healthVolume},target=/data`,'--entrypoint','node',image,'-e',healthFixture]);
 const before=await waitHealth('unhealthy');
 const script=`import importlib.util,tempfile,pathlib,sys
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('watchdog','deploy/devops/nest-watchdog.py');w=importlib.util.module_from_spec(spec);spec.loader.exec_module(w)
with tempfile.TemporaryDirectory() as root:
 with patch.object(w,'STATE',pathlib.Path(root)/'state/state.json'),patch.object(w,'DEPLOY_LOCK',pathlib.Path(root)/'operations/deployment.lock'),patch.object(w,'CONTAINER',sys.argv[1]):
  for now in [1000,1060,1120]:
   with patch.object(w.time,'time',return_value=now):w.recover()
`;
 execFileSync('python3',['-c',script,healthContainer],{encoding:'utf8',timeout:110_000});
 const after=await waitHealth('healthy');assert.notEqual(after.State.StartedAt,before.State.StartedAt);
 assert.equal(docker(['exec',healthContainer,'cat','/data/sentinel']),'durable-fixture');
 console.log('PASS: real Docker unhealthy fixture recovered through the host watchdog; synthetic volume preserved');
}finally{
 try{docker(['rm','--force','--volumes',healthContainer]);}catch{}
 try{docker(['volume','rm',healthVolume]);}catch{}
}
