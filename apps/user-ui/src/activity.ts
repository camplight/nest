import type {EventRow} from './types';
import {connectionAppName} from './components/ConnectionActions';
export type ActivityTone='neutral'|'success'|'danger'|'muted';
export type ActivityIcon='thinking'|'check'|'error'|'terminal'|'output'|'tool'|'context'|'progress'|'stop';
/** Status describes this event, never the outcome of the whole conversation. */
export function activity(event:EventRow):{title:string;tone:ActivityTone;icon:ActivityIcon}{
  const p=event.payload&&typeof event.payload==='object'?event.payload as Record<string,unknown>:{};
  const tool=typeof p.tool==='string'?p.tool:'Tool';
  switch(event.type){
    case 'agent.turn.started':case 'wrapper.turn.started':return {title:'Agent is thinking',tone:'neutral',icon:'thinking'};
    case 'agent.turn.completed':case 'wrapper.turn.completed':return p.cancelled===true?{title:'Stopped',tone:'muted',icon:'stop'}:{title:'Response completed',tone:'success',icon:'check'};
    case 'agent.turn.cancel_requested':return {title:'Stop requested',tone:'muted',icon:'stop'};
    case 'agent.context.compacted':return {title:'Summarized earlier messages',tone:'muted',icon:'context'};
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
    case 'telemetry.nest.connection.action':{
      const line=connectionActionLine(event);
      if(line)return {title:line.text,tone:line.tone==='danger'?'danger':line.tone==='muted'?'muted':'success',icon:line.tone==='danger'?'error':'tool'};
      const named=typeof p.app==='string'&&p.app&&typeof p.title==='string'&&p.title.trim()?`${connectionAppName(p.app)} · ${p.title.trim()}`:'App action';
      return {title:named,tone:p.outcome==='failed'?'danger':'neutral',icon:p.outcome==='failed'?'error':'tool'};
    }
    default:return {title:'Agent progress',tone:'neutral',icon:'progress'};
  }
}
export function activityDetails(event:EventRow){
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

/** A connected-app change as one short line: "Miro · Create image item from URL". */
export function connectionActionLine(event:EventRow):{app:string;text:string;tone:'neutral'|'danger'|'muted'}|null{
  if(event.type!=='telemetry.nest.connection.action')return null;
  const p=event.payload&&typeof event.payload==='object'?event.payload as Record<string,unknown>:{};
  const {app,title,outcome,change}=p;
  if(typeof app!=='string'||!app||typeof title!=='string'||!title.trim())return null;
  // Reads and untagged tools are recorded for the working ring only, never as lines.
  if(change==='read'||change==='other')return null;
  const name=connectionAppName(app),base=`${name} · ${title.trim()}`;
  if(outcome==='ok')return {app,text:base,tone:'neutral'};
  if(outcome==='failed')return {app,text:`${base} failed`,tone:'danger'};
  if(outcome==='unknown')return {app,text:`${base} may not have finished. Check ${name} before trying again`,tone:'muted'};
  return null;
}

const KNOWN_FAILURES:[RegExp,string][]=[
  [/\b(image|video)\b.*\b(invalid|unsupported|not support)|\b(invalid|unsupported)\b.*\b(image|video)\b/i,"this model can't read images."],
  [/suspended|spending limit|insufficient (funds|credit|balance)|out of credit|payment required|\b402\b/i,'the model provider account is suspended or out of credit.'],
  [/did not complete|timed out|timeout/i,"the model request didn't complete."],
  [/no reply text/i,'the model returned no reply.'],
];
/** A failed turn in one plain sentence, naming the agent. */
export function turnFailureText(event:EventRow,agentName:string):string{
  const p=event.payload&&typeof event.payload==='object'?event.payload as Record<string,unknown>:{};
  const error=typeof p.error==='string'?p.error.trim():'';
  if(!error)return `${agentName} couldn't finish this turn.`;
  const known=KNOWN_FAILURES.find(([pattern])=>pattern.test(error));
  if(known)return `${agentName} couldn't finish: ${known[1]}`;
  // Drop "AI_APICallError:" / "TypeError:" style prefixes, keep the first sentence, cap the length.
  const plain=error.replace(/^(\w*Error:\s*)+/,'').split(/(?<=[.!?])\s/)[0]!.trim();
  const sentence=plain.length>140?`${plain.slice(0,139).trimEnd()}…`:plain;
  return `${agentName} couldn't finish: ${sentence}`;
}
