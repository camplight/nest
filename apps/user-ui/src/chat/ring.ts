// What an agent is doing in its open turn, for the working ring (spec: working ring on hover).
// Built from action names only: tool arguments, outputs, paths and provider results never reach it.
// App calls come from Nest's action lines; for agents whose chat gets none (OrgOps-native agents run the connections
// command without the chat id), they come from the command itself, as in Apps here, reduced to the app and action name.
import type {EventRow} from '../types';
import {connectionAppName} from '../components/ConnectionActions';
import {classifyCommand,commandOf} from '../app-activity';

export type RingStation={key:string;label:string;app?:string;count:number;failed:boolean};
/** One feed line; `count` is how many identical actions in a row it stands for, `at` the latest of them. */
export type RingEntry={id:string;station:string;text:string;failed:boolean;at:number;count:number};
/** What the agent is doing now: thinking between actions, waiting on a command (since it started), using an app inside a command, or running another tool. */
export type RingStatus={kind:'thinking'}|{kind:'command';since:number}|{kind:'app';label:string}|{kind:'working'};
export type RingState={stations:RingStation[];feed:RingEntry[];actions:number;thinking:boolean;status:RingStatus};
export const RING_MAX_STATIONS=8;

export const elapsed=(ms:number)=>{const s=Math.max(0,Math.floor(ms/1000));return s<60?`${s}s`:`${Math.floor(s/60)}m ${s%60}s`;};
/** One line saying what the agent is doing right now. */
export const ringStatusText=(agent:string,status:RingStatus,now:number)=>
 status.kind==='thinking'?`${agent} is thinking…`
 :status.kind==='command'?`${agent} is waiting on a command · ${elapsed(now-status.since)}`
 :status.kind==='app'?`${agent} is using ${status.label}`
 :`${agent} is working`;
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

const isActionLine=(event:EventRow)=>{const p=record(event.payload);return event.type==='telemetry.nest.connection.action'&&typeof p.app==='string'&&!!p.app&&typeof p.title==='string'&&!!p.title.trim();};

/** The app and action a shell command calls, as names only; null for any other command. */
function appCommand(event:EventRow):{app:string;label:string;text:string}|null{
 const raw=commandOf(event.payload);
 const call=raw===null?null:classifyCommand(raw);
 return call?{app:call.app,label:call.appName,text:`${call.appName} · ${call.action}`}:null;
}

export function ringState(events:readonly EventRow[],agent:string,since:number):RingState{
 const stations:RingStation[]=[];
 const own=(event:EventRow)=>(event.createdAt??0)>=since&&agentOf(event)===agent;
 // Action lines are the better record; when this turn has any, commands are not read for apps, so nothing counts twice.
 const readCommands=!events.some(event=>own(event)&&isActionLine(event));
 // The app each running shell tool calls (null for other commands), first in, first out like shellStarts.
 const shellApps:(ReturnType<typeof appCommand>)[]=[];
 const feed:RingEntry[]=[];
 let actions=0,inFlight=0,shellInFlight=0,shellFailures=0;
 // Start times of running shell tools, and the latest app used: an app call made since the newest command began names that command.
 const shellStarts:number[]=[];
 let lastApp:{label:string;at:number}|undefined;
 const station=(key:string,label:string,app?:string)=>{
  let found=stations.find(item=>item.key===key);
  if(!found){found={key,label,...(app?{app}:{}),count:0,failed:false};stations.push(found);}
  return found;
 };
 const add=(event:EventRow,key:string,text:string,failed:boolean)=>{
  const at=event.createdAt??0,last=feed.at(-1);
  if(last&&last.text===text&&last.failed===failed){last.count++;last.at=at;}
  else feed.push({id:event.id,station:key,text,failed,at,count:1});
 };
 for(const event of events){
  if(!own(event))continue;
  const p=record(event.payload);
  const tool=typeof p.tool==='string'?p.tool:'';
  if(event.type==='tool.started'){
   const {key,label}=family(tool);
   const app=key==='shell'&&readCommands?appCommand(event):null;
   if(app){station(`app:${app.app}`,app.label,app.app).count++;lastApp={label:app.label,at:event.createdAt??0};}
   else station(key,label).count++;
   actions++;inFlight++;
   if(key==='shell'){shellInFlight++;shellStarts.push(event.createdAt??0);shellApps.push(app);}
  }else if(event.type==='tool.executed'||event.type==='tool.failed'){
   const {key,label}=family(tool);
   inFlight=Math.max(0,inFlight-1);
   // shell_run reports a non-zero exit as a normal result: its process exit already marked the failure.
   const exitFailed=key==='shell'&&shellFailures>0;
   const app=key==='shell'?shellApps.shift()??null:null;
   if(key==='shell'){shellInFlight=Math.max(0,shellInFlight-1);shellStarts.shift();if(exitFailed)shellFailures--;}
   const failed=event.type==='tool.failed'||exitFailed;
   if(app){
    const appKey=`app:${app.app}`;
    if(failed)station(appKey,app.label,app.app).failed=true;
    add(event,appKey,app.text,failed);
    continue;
   }
   if(failed)station(key,label).failed=true;
   add(event,key,exitFailed?'Shell · a command stopped with an error':`${label} · ${verb(tool,key)}`,failed);
  }else if(event.type==='process.exited'&&typeof p.exitCode==='number'&&p.exitCode!==0){
   // A failing app command marks its app when its tool result arrives; any other marks Shell now.
   if(!(shellInFlight>0&&shellApps[0]))station('shell','Shell').failed=true;
   // While a shell tool is running, its result carries this failure; a background command's exit stands alone.
   if(shellInFlight>0)shellFailures++;else add(event,'shell','Shell · a command stopped with an error',true);
  }else if(isActionLine(event)&&typeof p.app==='string'&&typeof p.title==='string'){
   const label=connectionAppName(p.app),key=`app:${p.app}`;
   const target=station(key,label,p.app);
   const failed=p.outcome==='failed';
   target.count++;actions++;
   lastApp={label,at:event.createdAt??0};
   if(failed)target.failed=true;
   add(event,key,`${label} · ${p.title.trim()}`,failed);
  }
 }
 const newestCommand=shellStarts.at(-1);
 const status:RingStatus=inFlight===0?{kind:'thinking'}
  :newestCommand===undefined?{kind:'working'}
  :lastApp&&lastApp.at>=newestCommand?{kind:'app',label:lastApp.label}
  :{kind:'command',since:shellStarts[0]!};
 return {stations:fold(stations),feed:feed.slice(-FEED_SIZE).reverse(),actions,thinking:inFlight===0,status};
}

/** First-use order; past the limit the first seven stay and the rest share one "Other" station. */
function fold(stations:RingStation[]):RingStation[]{
 if(stations.length<=RING_MAX_STATIONS)return stations;
 const kept=stations.slice(0,RING_MAX_STATIONS-1).filter(item=>item.key!=='other');
 const rest=stations.filter(item=>!kept.includes(item));
 const other:RingStation={key:'other',label:'Other',count:rest.reduce((sum,item)=>sum+item.count,0),failed:rest.some(item=>item.failed)};
 return [...kept,other];
}

/** A finished turn, for the ring on a reply: its span and how it ended. */
export type FinishedTurn={since:number;until:number;outcome:'done'|'stopped'|'failed'};
const STARTS=new Set(['agent.turn.started','wrapper.turn.started']);
const ENDS=new Set(['agent.turn.completed','agent.turn.failed','wrapper.turn.completed','wrapper.turn.failed']);

/**
 * Reads the agent's turn from a reply's activity events; without the start or end event it uses the first or last event.
 * A turn without a single action has nothing for the ring to show, so it reads as null like a turn with no events.
 */
export function finishedTurn(events:readonly EventRow[],agent:string):FinishedTurn|null{
 const own=events.filter(event=>agentOf(event)===agent);
 if(!own.length)return null;
 const at=(event:EventRow|undefined)=>event?.createdAt??0;
 const start=own.find(event=>STARTS.has(event.type)),end=[...own].reverse().find(event=>ENDS.has(event.type));
 const since=at(start??own[0]);
 if(ringState(events,agent,since).actions===0)return null;
 const outcome=end?.type.endsWith('.failed')?'failed':end&&record(end.payload).cancelled===true?'stopped':'done';
 return {since,until:at(end??own.at(-1)),outcome};
}

export const finishedText=(agent:string,turn:FinishedTurn)=>{
 const took=elapsed(turn.until-turn.since);
 return turn.outcome==='done'?`${agent} worked for ${took}`:`${agent} ${turn.outcome} after ${took}`;
};
