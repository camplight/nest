// What an agent is doing in its open turn, for the working ring (spec: working ring on hover).
// Built from action names only: tool arguments, outputs, paths and provider results never reach it.
import type {EventRow} from '../types';
import {connectionAppName} from '../components/ConnectionActions';

export type RingStation={key:string;label:string;app?:string;count:number;failed:boolean};
export type RingEntry={id:string;station:string;text:string;failed:boolean;at:number};
export type RingState={stations:RingStation[];feed:RingEntry[];actions:number;thinking:boolean};
export const RING_MAX_STATIONS=8;
const FEED_SIZE=5;

const FAMILIES:[prefix:string,key:string,label:string][]=[
 ['shell_','shell','Shell'],['fs_','files','Files'],['memory_','memory','Memory'],['events_','messages','Messages'],['agents_','agents','Agents'],
];
const VERBS:Record<string,string>={
 shell_run:'ran a command',shell_start:'started a background command',shell_status:'checked a command',shell_tail:'checked a command',shell_stop:'stopped a command',
 fs_read:'read a file',fs_write:'wrote a file',fs_list:'listed a folder',fs_stat:'looked at a file',fs_mkdir:'made a folder',fs_move:'moved a file',fs_rm:'deleted a file',fs_upload:'uploaded a file',
 events_emit:'posted an event',events_channel_messages:'read messages',events_search:'searched messages',
};
const FAMILY_VERBS:Record<string,string>={shell:'ran a command',files:'used a file',memory:'used memory',messages:'used channels',agents:'managed agents',other:'used a tool'};

const record=(payload:unknown):Record<string,unknown>=>payload&&typeof payload==='object'?payload as Record<string,unknown>:{};
function agentOf(event:EventRow):string|undefined{
 const p=record(event.payload);
 for(const key of ['agentName','ownerAgentName','targetAgentName']){const name=p[key];if(typeof name==='string'&&name)return name;}
 return event.source.startsWith('agent:')?event.source.slice(6):undefined;
}
function family(tool:string):{key:string;label:string}{
 const found=FAMILIES.find(([prefix])=>tool.startsWith(prefix));
 return found?{key:found[1],label:found[2]}:{key:'other',label:'Other'};
}
function verb(tool:string,key:string):string{
 if(VERBS[tool])return VERBS[tool]!;
 if(key==='memory')return /_(get|read)$/.test(tool)?'read memory':'updated memory';
 return FAMILY_VERBS[key]??'used a tool';
}

export function ringState(events:readonly EventRow[],agent:string,since:number):RingState{
 const stations:RingStation[]=[];
 const feed:RingEntry[]=[];
 let actions=0,inFlight=0,shellInFlight=0,shellFailures=0;
 const station=(key:string,label:string,app?:string)=>{
  let found=stations.find(item=>item.key===key);
  if(!found){found={key,label,...(app?{app}:{}),count:0,failed:false};stations.push(found);}
  return found;
 };
 const add=(event:EventRow,key:string,text:string,failed:boolean)=>feed.push({id:event.id,station:key,text,failed,at:event.createdAt??0});
 for(const event of events){
  if((event.createdAt??0)<since||agentOf(event)!==agent)continue;
  const p=record(event.payload);
  const tool=typeof p.tool==='string'?p.tool:'';
  if(event.type==='tool.started'){
   const {key,label}=family(tool);
   station(key,label).count++;actions++;inFlight++;
   if(key==='shell')shellInFlight++;
  }else if(event.type==='tool.executed'||event.type==='tool.failed'){
   const {key,label}=family(tool);
   inFlight=Math.max(0,inFlight-1);
   // shell_run reports a non-zero exit as a normal result: its process exit already marked the failure.
   const exitFailed=key==='shell'&&shellFailures>0;
   if(key==='shell'){shellInFlight=Math.max(0,shellInFlight-1);if(exitFailed)shellFailures--;}
   const failed=event.type==='tool.failed'||exitFailed;
   if(failed)station(key,label).failed=true;
   add(event,key,exitFailed?'Shell · a command stopped with an error':`${label} · ${verb(tool,key)}`,failed);
  }else if(event.type==='process.exited'&&typeof p.exitCode==='number'&&p.exitCode!==0){
   station('shell','Shell').failed=true;
   // While a shell tool is running, its result carries this failure; a background command's exit stands alone.
   if(shellInFlight>0)shellFailures++;else add(event,'shell','Shell · a command stopped with an error',true);
  }else if(event.type==='telemetry.nest.connection.action'&&typeof p.app==='string'&&p.app&&typeof p.title==='string'&&p.title.trim()){
   const label=connectionAppName(p.app),key=`app:${p.app}`;
   const target=station(key,label,p.app);
   const failed=p.outcome==='failed';
   target.count++;actions++;
   if(failed)target.failed=true;
   add(event,key,`${label} · ${p.title.trim()}`,failed);
  }
 }
 return {stations:fold(stations),feed:feed.slice(-FEED_SIZE).reverse(),actions,thinking:inFlight===0};
}

/** First-use order; past the limit the first seven stay and the rest share one "Other" station. */
function fold(stations:RingStation[]):RingStation[]{
 if(stations.length<=RING_MAX_STATIONS)return stations;
 const kept=stations.slice(0,RING_MAX_STATIONS-1).filter(item=>item.key!=='other');
 const rest=stations.filter(item=>!kept.includes(item));
 const other:RingStation={key:'other',label:'Other',count:rest.reduce((sum,item)=>sum+item.count,0),failed:rest.some(item=>item.failed)};
 return [...kept,other];
}
