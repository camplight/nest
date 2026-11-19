import {randomUUID} from 'node:crypto';
import type {ProductDb} from '@nest/db';
import {generateProjectDetails,projectDetailsSchema,type ProjectNamer} from './project-naming';

type Job={project_id:string;request_id:string;expected_name:string;expected_description:string;attempts:number;lease:string};
export type NamingContext={model:string;text:string;env?:Record<string,string|undefined>};
/** A failed step with a fixed, log-safe category; thrown by the context source so the worker never parses messages. */
export type NamingFailure='provider unavailable'|'model unavailable';
export class NamingStepError extends Error {
  constructor(readonly category:NamingFailure,options?:{cause?:unknown}){super(category,options);this.name='NamingStepError';}
}
// Each API process may poll: SQLite leases coordinate work; stale workers cannot commit.
export function createProjectNamingWorker({store,context,namer=generateProjectDetails,now=Date.now,log=line=>console.warn(line)}:{store:ProductDb;context:(projectId:string,requestId:string)=>Promise<NamingContext|null>;namer?:ProjectNamer;now?:()=>number;log?:(line:string)=>void}) {
  let active=false;
  async function tick() {
    if(active)return;
    active=true;
    let job:Job|undefined;
    // Which step is running, so a failure is categorised by step and never by its message.
    let step:'context unavailable'|'generation failed'='context unavailable';
    try {
      job=store.db.transaction(()=>{
        store.db.prepare("UPDATE product_project_naming SET status='failed',lease=NULL WHERE status='pending' AND attempts>=5 AND lease_until<=?").run(now());
        const row=store.db.prepare("SELECT * FROM product_project_naming WHERE status='pending' AND attempts<5 AND next_at<=? AND lease_until<=? ORDER BY next_at LIMIT 1").get(now(),now()) as Job|undefined;
        if(!row)return;
        const lease=randomUUID();
        store.db.prepare('UPDATE product_project_naming SET attempts=attempts+1,lease=?,lease_until=? WHERE project_id=?').run(lease,now()+600_000,row.project_id);
        return {...row,lease,attempts:row.attempts+1};
      })();
      if(!job)return;
      let status='kept';
      if(store.projects.canNameProject(job.project_id)) {
        const input=await context(job.project_id,job.request_id);
        if(input) {
          step='generation failed';
          const details=projectDetailsSchema.parse(await namer(input));
          step='context unavailable';
          // Recheck engine source/access after generation before updating product state.
          const current=await context(job.project_id,job.request_id);
          if(current&&current.text===input.text&&current.model===input.model) {
            store.db.transaction(()=>{
              if(!store.db.prepare('SELECT 1 FROM product_project_naming WHERE project_id=? AND lease=? AND lease_until>?').get(job!.project_id,job!.lease,now()))return;
              const project=store.projects.project(job!.project_id);
              if(project&&store.projects.updateProject(project.id,project.ownerId,details,{name:job!.expected_name,description:job!.expected_description},'ai'))status='named';
            })();
          }
        }
      }
      store.db.prepare('UPDATE product_project_naming SET status=?,lease=NULL,lease_until=0 WHERE project_id=? AND lease=?').run(status,job.project_id,job.lease);
    } catch(error) {
      if(job)store.db.prepare('UPDATE product_project_naming SET status=?,next_at=?,lease=NULL,lease_until=0 WHERE project_id=? AND lease=?')
        .run(job.attempts>=5?'failed':'pending',now()+Math.min(900_000,30_000*2**(job.attempts-1)),job.project_id,job.lease);
      // Provider errors may contain credentials or prompt text; log only a fixed category.
      log(`project naming: ${error instanceof NamingStepError?error.category:step}`);
    } finally {active=false;}
  }
  return {tick};
}
