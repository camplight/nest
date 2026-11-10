import {dayKey,type TimelineItem} from './timeline';

export type AgentFold={id:string;messageIds:string[];hiddenIds:string[];latestId:string};
// Activity belongs to the preceding message. It neither counts toward the
// threshold nor splits an agent conversation; hidden messages take it with them.
export function agentFolds(items:readonly TimelineItem[]):AgentFold[]{
 const folds:AgentFold[]=[];
 let run:TimelineItem[]=[];
 const flush=()=>{
  const messages=run.filter(item=>item.kind==='message');
  if(messages.length>=3){
   const latest=messages[messages.length-1];
   folds.push({id:messages[0].id,messageIds:messages.map(item=>item.id),latestId:latest.id,
    hiddenIds:run.slice(0,run.indexOf(latest)).map(item=>item.id)});
  }
  run=[];
 };
 for(const item of items){
  if(run.length&&(dayKey(run[0].meta.displayAt)!==dayKey(item.meta.displayAt)||Boolean(run[0].meta.detached)!==Boolean(item.meta.detached)))flush();
  if(item.kind==='message'){
   if(item.meta.authorKind!=='agent'){flush();continue;}
   run.push(item);
  }else if(run.length)run.push(item);
 }
 flush();return folds;
}

export function foldAgentTimeline(items:TimelineItem[],expanded:ReadonlySet<string>,focusedId:string|null){
 const hidden=new Set<string>();
 const controls=new Map<string,{fold:AgentFold;expanded:boolean}>();
 const redirects=new Map<string,string>();
 for(const fold of agentFolds(items)){
  const open=expanded.has(fold.id)||(focusedId!==null&&fold.messageIds.includes(focusedId)&&focusedId!==fold.latestId);
  controls.set(open?fold.id:fold.latestId,{fold,expanded:open});
  if(!open)for(const id of fold.hiddenIds){hidden.add(id);redirects.set(id,fold.latestId);}
 }
 return {items:items.filter(item=>!hidden.has(item.id)),controls,redirects};
}
