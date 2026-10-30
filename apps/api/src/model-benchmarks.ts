import {createHash} from 'node:crypto';
import type {ModelBenchmarks} from '@nest/schemas';

export function normalizeBenchmarks(value:unknown,now:number):ModelBenchmarks {
  const input=value as {data?:unknown[];meta?:{as_of?:unknown;version?:unknown}};
  if(!Array.isArray(input?.data))throw Error('Invalid benchmarks');
  const rows=new Map<string,ModelBenchmarks['models'][number]>();
  const ambiguous=new Set<string>();
  for(const row of input.data as any[]){
    if(row?.source!=='artificial-analysis'||typeof row.model_permaslug!=='string'||!/^[-\w.]+\/[-\w.]+$/.test(row.model_permaslug))continue;
    const score=row.intelligence_index;
    if(typeof score!=='number'||!Number.isFinite(score)||score<0||score>100)continue;
    const previous=rows.get(row.model_permaslug);
    if(previous&&previous.intelligence!==score)ambiguous.add(row.model_permaslug);
    rows.set(row.model_permaslug,{id:row.model_permaslug,intelligence:score});
  }
  const models=[...rows.values()].filter(row=>!ambiguous.has(row.id));
  if(!models.length)throw Error('No comparable scores');
  return {models,fetchedAt:now,stale:false,asOf:typeof input.meta?.as_of==='string'&&Number.isFinite(Date.parse(input.meta.as_of))?input.meta.as_of:null};
}

/** Credentials never leave the server; cache isolation follows the actual provider key. */
export function createModelBenchmarks(transport:typeof fetch=fetch,now=Date.now){
  const entries=new Map<string,{data?:ModelBenchmarks;retryAt?:number;pending?:Promise<ModelBenchmarks>}>();
  return async(key:string):Promise<ModelBenchmarks>=>{
    if(!key)throw Error('OpenRouter credentials unavailable');
    const id=createHash('sha256').update(key).digest('hex');
    let entry=entries.get(id);
    if(!entry){if(entries.size>=32)entries.delete(entries.keys().next().value!);entry={};entries.set(id,entry);}
    const cache=entry;
    if(cache.data&&now()-cache.data.fetchedAt<6*60*60_000)return cache.data;
    const fallback=()=>{if(cache.data&&now()-cache.data.fetchedAt<24*60*60_000)return {...cache.data,stale:true};throw Error('Benchmarks unavailable');};
    if(cache.retryAt&&now()<cache.retryAt)return fallback();
    if(cache.pending)return cache.pending;
    cache.pending=(async()=>{
      try {
        const response=await transport('https://openrouter.ai/api/v1/benchmarks?source=artificial-analysis&task_type=intelligence',{headers:{Authorization:`Bearer ${key}`},redirect:'error',signal:AbortSignal.timeout(8000)});
        if(!response.ok)throw Error('Benchmarks unavailable');
        cache.data=normalizeBenchmarks(await response.json(),now());return cache.data;
      }catch{cache.retryAt=now()+60_000;return fallback();}finally{cache.pending=undefined;}
    })();
    return cache.pending;
  };
}
