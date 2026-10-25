import {afterEach,describe,it,expect,vi} from 'vitest';
import {openProductDb} from '@nest/db';
import {createProjectNamingWorker} from './project-naming-worker';
const stores:ReturnType<typeof openProductDb>[]=[];
afterEach(()=>{for(const store of stores.splice(0))store.close();});
function setup(){
  const store=openProductDb(':memory:');stores.push(store);
  store.projects.createProject({id:'p',ownerId:'owner',channelId:'c',name:'Can you build a shop?',description:'Can you build a shop?',createdAt:1,collaboration:'team'});
  store.db.prepare('INSERT INTO product_message_requests(id,sender_id,sender_name,channel_id,input_hash,payload_hash,event_id,created_at,delivered_at) VALUES(?,?,?,?,?,?,?,?,?)').run('r','owner','alice','c','hash','hash','event',1,2);
  store.db.prepare('INSERT INTO product_project_naming(project_id,request_id,expected_name,expected_description) VALUES(?,?,?,?)').run('p','r','Can you build a shop?','Can you build a shop?');
  return store;
}
const context=async()=>({model:'openrouter:fixture',text:'Can you build a shop?'});
const details={name:'Online Shop',description:'Build an online shop. Product range remains to be defined.'};
describe('durable project naming',()=>{
  it('resumes persisted work with a fresh worker and applies it once',async()=>{
    const store=setup(),namer=vi.fn(async()=>details);
    await createProjectNamingWorker({store,context,namer}).tick();
    await createProjectNamingWorker({store,context,namer}).tick();
    expect(namer).toHaveBeenCalledTimes(1);
    expect(store.projects.project('p')?.name).toBe(details.name);
  });
  it('backs off, retries with a fresh worker, and stops after five failures',async()=>{
    const store=setup(),namer=vi.fn(async()=>{throw Error('private diagnostic');});let time=0;
    const worker=()=>createProjectNamingWorker({store,context,namer,now:()=>time});
    await worker().tick();await worker().tick();expect(namer).toHaveBeenCalledTimes(1);
    for(let n=0;n<5;n++){time+=1_000_000;await worker().tick();}
    expect(namer).toHaveBeenCalledTimes(5);
    expect(store.db.prepare('SELECT status FROM product_project_naming').get()).toEqual({status:'failed'});
    expect(store.projects.project('p')?.name).toBe('Can you build a shop?');
  });
  it('leases prevent parallel calls and an expired worker cannot overwrite the winner',async()=>{
    const store=setup();let release!:(value:typeof details)=>void,time=0;
    const delayed=new Promise<typeof details>(resolve=>release=resolve),namer=vi.fn(()=>delayed);
    const first=createProjectNamingWorker({store,context,namer,now:()=>time}).tick();
    await vi.waitFor(()=>expect(namer).toHaveBeenCalledTimes(1));
    const winner=vi.fn(async()=>details);
    await createProjectNamingWorker({store,context,namer:winner,now:()=>time}).tick();expect(winner).not.toHaveBeenCalled();
    time=600_001;
    await createProjectNamingWorker({store,context,namer:winner,now:()=>time}).tick();
    release({name:'Stale output',description:'Must not apply'});await first;
    expect(store.projects.project('p')?.name).toBe(details.name);
  });
  it('honors same-value manual saves during generation',async()=>{
    const store=setup();
    await createProjectNamingWorker({store,context,namer:async()=>{
      const p=store.projects.project('p')!;store.projects.updateProject('p','owner',p,p);return details;
    }}).tick();
    expect(store.projects.project('p')?.name).toBe('Can you build a shop?');
  });
  it('discards output when source access disappears, and rejects malformed output',async()=>{
    const store=setup(),check=vi.fn().mockResolvedValueOnce(await context()).mockResolvedValue(null);
    await createProjectNamingWorker({store,context:check,namer:async()=>details}).tick();
    expect(store.db.prepare('SELECT status FROM product_project_naming').get()).toEqual({status:'kept'});
    store.db.prepare("UPDATE product_project_naming SET status='pending'").run();
    await createProjectNamingWorker({store,context,namer:async()=>({name:'',description:''})}).tick();
    expect(store.db.prepare('SELECT status FROM product_project_naming').get()).toEqual({status:'pending'});
    expect(store.projects.project('p')?.name).toBe('Can you build a shop?');
  });
});
