import type {EventRow} from './types';
import {classifyCommand,classifyToolEvent,type Classified} from './app-activity';
export type ActivityTone='neutral'|'success'|'danger'|'muted';
export type ActivityIcon='thinking'|'check'|'error'|'terminal'|'output'|'tool'|'context'|'progress';
/** What a process event's command did outside Nest, when it was an app call. */
type ProcessCall={agent:string;kind:'read'|'change';label:string|null};
/**
 * App calls in a chat's loaded events, for naming and redacting them in the timeline (Phase 2, behind the canvas
 * flag). Null means the flag is off: titles and details are exactly as before Phase 2.
 */
export type AppRedaction={calls:ReadonlyMap<string,ProcessCall>;started:ReadonlySet<string>};
const record=(payload:unknown):Record<string,unknown>=>payload&&typeof payload==='object'&&!Array.isArray(payload)?payload as Record<string,unknown>:{};
const processIdOf=(event:EventRow)=>{const id=record(event.payload).processId;return typeof id==='string'&&id?id:null;};
/** The agent a process belongs to: the engine names it in the payload (the source is the process runner). */
function processAgent(event:EventRow){
  const p=record(event.payload);
  return typeof p.ownerAgentName==='string'?p.ownerAgentName:typeof p.targetAgentName==='string'?p.targetAgentName:event.source.replace(/^agent:/,'');
}
/** The app call a process.started event's own command is, if any (the same classifier as tool events). */
function startedCall(event:EventRow):ProcessCall|null{
  if(event.type!=='process.started')return null;
  const cmd=record(event.payload).cmd;
  const call=typeof cmd==='string'?classifyCommand(cmd):null;
  return call?{agent:processAgent(event),kind:call.kind,label:call.label}:null;
}
/** Every `shell_run` also emits process.started (its command), process.output (its output) and process.exited, by processId. */
export function appRedaction(events:EventRow[]):AppRedaction{
  const calls=new Map<string,ProcessCall>(),started=new Set<string>();
  for(const event of events){
    const id=event.type==='process.started'?processIdOf(event):null;
    if(!id)continue;
    started.add(id);
    const call=startedCall(event);
    if(call)calls.set(id,call);
  }
  return {calls,started};
}
const PROCESS_TYPES=new Set(['process.started','process.output','process.exited']);
/** The app call behind a process event: its own command, or the start that shares its processId. */
function processCall(event:EventRow,apps:AppRedaction):ProcessCall|null{
  if(!PROCESS_TYPES.has(event.type))return null;
  const own=startedCall(event);
  if(own)return own;
  const id=processIdOf(event);
  return id?apps.calls.get(id)??null:null;
}
/** Status describes this event, never the outcome of the whole conversation. */
export function activity(event:EventRow,apps:AppRedaction|null=null):{title:string;tone:ActivityTone;icon:ActivityIcon}{
  const base=baseActivity(event);
  if(!apps)return base;
  // An app call is named for what it did outside Nest, never for its command.
  const call=appCall(event);
  return call?{...base,title:`${call.agent} · ${call.appName} · ${call.action} · ${call.kind==='read'?'read':'changed'}`}:base;
}
function toolName(event:EventRow):string{
  const tool=(event.payload as {tool?:unknown}|undefined)?.tool;
  return typeof tool==='string'?tool:'Tool';
}
/** The app call a tool event is, if any. Classification is fail-safe: anything uncertain is a change. */
function appCall(event:EventRow):Classified|null{
  return event.type.startsWith('tool.')?classifyToolEvent(event):null;
}
function baseActivity(event:EventRow):{title:string;tone:ActivityTone;icon:ActivityIcon}{
  const p=event.payload&&typeof event.payload==='object'?event.payload as Record<string,unknown>:{};
  const tool=typeof p.tool==='string'?p.tool:'Tool';
  switch(event.type){
    case 'agent.turn.started':case 'wrapper.turn.started':return {title:'Agent is thinking',tone:'neutral',icon:'thinking'};
    case 'agent.turn.completed':case 'wrapper.turn.completed':return {title:'Response completed',tone:'success',icon:'check'};
    case 'agent.turn.failed':case 'wrapper.turn.failed':return {title:'Agent could not finish',tone:'danger',icon:'error'};
    case 'process.started':return {title:'Agent process started',tone:'neutral',icon:'terminal'};
    case 'process.exited':{
      const code=typeof p.exitCode==='number'?p.exitCode:null;
      return code===0?{title:'Agent process finished',tone:'success',icon:'check'}:code===null?{title:'Agent process stopped',tone:'muted',icon:'terminal'}:{title:'Agent process stopped with an error',tone:'danger',icon:'error'};
    }
    case 'process.output':return {title:p.stream==='STDERR'?'Diagnostic output':'Agent output',tone:'muted',icon:'output'};
    case 'tool.started':return {title:`Using ${tool}`,tone:'neutral',icon:'tool'};
    case 'tool.executed':return {title:`${tool} completed`,tone:'success',icon:'check'};
    case 'tool.failed':return {title:`${tool} failed`,tone:'danger',icon:'error'};
    case 'telemetry.context.window.updated':return {title:'Conversation context updated',tone:'muted',icon:'context'};
    default:return {title:'Agent progress',tone:'neutral',icon:'progress'};
  }
}
export function activityDetails(event:EventRow,apps:AppRedaction|null=null){
  // App calls show tool, time, agent, read or change and the label only; never the command, arguments or output.
  const time=event.createdAt===undefined?null:new Date(event.createdAt).toISOString();
  const call=apps?appCall(event):null;
  if(call)return JSON.stringify({tool:toolName(event),time,agent:call.agent,kind:call.kind,label:call.label},null,2);
  // The process events of an app call are redacted the same way. Output whose start is not loaded may belong to one,
  // so its text stays hidden until the start is (it shows once older messages load).
  const processed=apps?processCall(event,apps):null;
  if(processed)return JSON.stringify({event:event.type,time,agent:processed.agent,kind:processed.kind,label:processed.label},null,2);
  if(apps&&event.type==='process.output'&&!apps.started.has(processIdOf(event)??''))
    return JSON.stringify({event:event.type,time,agent:processAgent(event),detail:'Load earlier messages to see this output.'},null,2);
  // Preserve the entire recorded payload, including process output and tool arguments.
  return JSON.stringify({event:event.type,source:event.source,payload:event.payload},null,2);
}

/** Latest public update for each active wrapped turn, across interleaved messages. */
export function activeAgentProgress(events:EventRow[]):Set<string>{
  const active=new Map<string,EventRow>(),finished=new Set<string>();
  for(const event of events){
    const p=event.payload&&typeof event.payload==='object'?event.payload as Record<string,unknown>:{};
    const agent=event.source.startsWith('agent:')?event.source.slice(6):typeof p.targetAgentName==='string'?p.targetAgentName:'';
    if(!agent||typeof p.triggerEventId!=='string')continue;
    const key=JSON.stringify([agent,p.triggerEventId]);
    if(['agent.turn.completed','agent.turn.failed','wrapper.turn.completed','wrapper.turn.failed'].includes(event.type)){
      finished.add(key);active.delete(key);
    }else if(event.type==='agent.turn.started'){
      finished.delete(key);
      for(const [id,row] of active)if(row.source===`agent:${agent}`)active.delete(id);
    }else if(event.type==='agent.turn.phase'&&p.phase==='codex-progress'&&typeof p.text==='string'&&p.text.trim()&&!finished.has(key)){
      active.set(key,event);
    }
  }
  return new Set([...active.values()].map(event=>event.id));
}
