import type {EventRow} from './types';
import {classifyCommand,classifyToolEvent,foldCalls,type AppCall,type Classified} from './app-activity';
export type ActivityTone='neutral'|'success'|'danger'|'muted';
export type ActivityIcon='thinking'|'check'|'error'|'terminal'|'output'|'tool'|'context'|'progress';
/** What a process event's command did outside Nest, when it was an app call. */
type ProcessCall={agent:string;kind:'read'|'change';label:string|null};
/**
 * App calls in a chat's loaded events, for naming and redacting them in the timeline (Phase 2, behind the canvas
 * flag). Null means the flag is off: titles and details are exactly as before Phase 2.
 */
export type AppRedaction={
  calls:ReadonlyMap<string,ProcessCall>;started:ReadonlySet<string>;
  /** Each app call of the chat, by the id of the event that begins it (its tool.started, or a lone result). */
  lines:ReadonlyMap<string,AppCall>;
  /** The process events (start, output, exit) of an app call's shell command: its line stands for them. */
  processEvents:ReadonlySet<string>;
  /** Every tool event that is part of an app call, including results paired to a start: none is drawn as a chip. */
  appEvents:ReadonlySet<string>;
};
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
export function appRedaction(events:EventRow[],now:number=Date.now()):AppRedaction{
  const calls=new Map<string,ProcessCall>(),started=new Set<string>(),appEvents=new Set<string>();
  const tools=events.filter(event=>event.type.startsWith('tool.'));
  for(const event of tools)if(appCall(event))appEvents.add(event.id);
  const lines=new Map(foldCalls(tools,now).map(call=>[call.id,call]));
  for(const event of events){
    const id=event.type==='process.started'?processIdOf(event):null;
    if(!id)continue;
    started.add(id);
    const call=startedCall(event);
    if(call)calls.set(id,call);
  }
  const redaction:AppRedaction={calls,started,lines,appEvents,processEvents:new Set()};
  const processEvents=new Set<string>();
  for(const event of events)if(processCall(event,redaction))processEvents.add(event.id);
  return {...redaction,processEvents};
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
// Verbs as [doing, did, base]; the mock phrases a line as a lowercase clause after the agent's name.
const VERBS:Record<string,[string,string,string]>={
  send:['sending','sent','send'],fetch:['fetching','fetched','fetch'],get:['getting','got','get'],find:['finding','found','find'],
  list:['listing','listed','list'],search:['searching','searched','search'],read:['reading','read','read'],query:['querying','queried','query'],
  create:['creating','created','create'],add:['adding','added','add'],update:['updating','updated','update'],delete:['deleting','deleted','delete'],
  remove:['removing','removed','remove'],move:['moving','moved','move'],archive:['archiving','archived','archive'],reply:['replying','replied','reply'],
  forward:['forwarding','forwarded','forward'],post:['posting','posted','post'],upload:['uploading','uploaded','upload'],download:['downloading','downloaded','download'],
  merge:['merging','merged','merge'],close:['closing','closed','close'],view:['viewing','viewed','view'],set:['setting','set','set'],
  patch:['patching','patched','patch'],export:['exporting','exported','export'],check:['checking','checked','check'],diff:['diffing','diffed','diff'],
  status:['checking','checked','check']
};
const ACRONYMS=new Set(['pr','url','api','id','csv','pdf','sql','ci','html','json']);
const GH_NOUNS:Record<string,string>={pr:'a PR',issue:'an issue',repo:'a repo',run:'a run',release:'a release',workflow:'a workflow',gist:'a gist',label:'a label',project:'a project'};
/** A lowercase label with acronyms (PR, URL, API, ID) kept upper case. */
const humanise=(text:string)=>text.toLowerCase().split(/\s+/).filter(Boolean).map(word=>ACRONYMS.has(word)?word.toUpperCase():word).join(' ');
const GH_PLURALS:Record<string,string>={pr:'PRs',issue:'issues',repo:'repos',run:'runs',release:'releases',workflow:'workflows',gist:'gists',label:'labels',project:'projects'};
const PREPOSITIONS=new Set(['to','in','on','from','for','with','of','at','by','into','the','a','an']);
/** An article goes only before a lone singular noun straight after the verb: not before a plural, a preposition or a longer phrase. */
const withArticle=(object:string)=>{
  if(!object||object.includes(' ')||object.endsWith('s')||PREPOSITIONS.has(object))return object;
  return /^[aeiou]/i.test(object)?`an ${object}`:`a ${object}`;
};
/** What the agent did, as the clause that follows its name: "sent an email", "merged a PR in acme/web". */
export function appLinePhrase(call:AppCall):string{
  const form=call.state==='running'?0:call.state==='failed'?2:1;
  const words=call.action.trim().split(/\s+/);
  // gh actions are lowercase `group sub`; connected-app actions come from their action name.
  const gh=call.app==='github'&&/^[a-z]/.test(call.action)&&call.action!==call.action.toUpperCase();
  const place=call.label?` in ${call.label}`:'';
  if(gh){
    const [group,sub]=words;
    if(group==='api')return `${['calling','called','tried to call'][form]} the GitHub API${place}`;
    const verb=VERBS[sub??''],noun=sub==='list'?GH_PLURALS[group]:GH_NOUNS[group];
    if(verb&&noun)return `${form===2?'tried to '+verb[2]:verb[form]} ${noun}${place}`;
    return `${form===2?'tried to use':form===0?'using':'used'} gh ${humanise(call.action)}${place}`;
  }
  const verb=VERBS[(words[0]??'').toLowerCase()];
  const rest=humanise(words.slice(1).join(' '));
  // "send email" reads "sent an email"; plurals, prepositional and longer objects stay bare ("replied to thread").
  const object=withArticle(rest);
  if(!verb)return `${form===2?'tried to use':form===0?'using':'used'} ${humanise(call.action)}${place}`;
  return `${form===2?'tried to '+verb[2]:verb[form]}${object?' '+object:''}${place}`;
}
/** The words after "changed"/"read" in an expanded line. */
const KIND:Record<AppCall['kind'],Record<AppCall['state'],string>>={
  read:{running:'reading something outside Nest',done:'read something outside Nest',failed:'tried to read something outside Nest'},
  change:{running:'changing something outside Nest',done:'changed something outside Nest',failed:'tried to change something outside Nest'}
};
/** An expanded app line, in plain words: app, what was done, and when. Never a command, argument or output. */
export function appLineDetails(call:AppCall,formatTime:(time?:number)=>string):string{
  const when=formatTime(call.at),done=call.state==='done'?`done at ${when}`:call.state==='failed'?`failed at ${when}`:`started at ${when}, still running`;
  return `${call.appName} · ${appLinePhrase(call)}\n${KIND[call.kind][call.state]} · ${done}`;
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
