import type {EventRow} from './types';
export type ActivityTone='neutral'|'success'|'danger'|'muted';
export type ActivityIcon='thinking'|'check'|'error'|'terminal'|'output'|'tool'|'context'|'progress';
/** Status describes this event, never the outcome of the whole conversation. */
export function activity(event:EventRow):{title:string;tone:ActivityTone;icon:ActivityIcon}{
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
    }else if(event.type==='agent.turn.phase'&&(p.phase==='codex-progress'||p.phase==='wrapped-progress')&&typeof p.text==='string'&&p.text.trim()&&!finished.has(key)){
      active.set(key,event);
    }
  }
  return new Set([...active.values()].map(event=>event.id));
}
