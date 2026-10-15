import type {EventRow} from './types';
export type ActivityTone='neutral'|'success'|'danger'|'muted';
export type ActivityIcon='thinking'|'check'|'error'|'terminal'|'output'|'tool'|'context'|'progress';
/** Status describes this event, never the outcome of the whole conversation. */
export function activity(event:EventRow):{title:string;description:string;tone:ActivityTone;icon:ActivityIcon}{
  const p=event.payload&&typeof event.payload==='object'?event.payload as Record<string,unknown>:{};
  const tool=typeof p.tool==='string'?p.tool:'Tool';
  switch(event.type){
    case 'agent.turn.started':case 'wrapper.turn.started':return {title:'Agent is thinking',description:'The agent started working on a response.',tone:'neutral',icon:'thinking'};
    case 'agent.turn.completed':case 'wrapper.turn.completed':return {title:'Response completed',description:'The agent finished this response.',tone:'success',icon:'check'};
    case 'agent.turn.failed':case 'wrapper.turn.failed':return {title:'Agent could not finish',description:'The agent encountered an error while working on this response. Open technical details for the available error information.',tone:'danger',icon:'error'};
    case 'process.started':return {title:'Agent process started',description:'The program running this agent has started.',tone:'neutral',icon:'terminal'};
    case 'process.exited':{
      const code=typeof p.exitCode==='number'?p.exitCode:null;
      return code===0?{title:'Agent process finished',description:'The agent program ended successfully.',tone:'success',icon:'check'}:code===null?{title:'Agent process stopped',description:'The agent program ended without reporting an exit status. This does not confirm success or failure.',tone:'muted',icon:'terminal'}:{title:'Agent process stopped with an error',description:`The agent program ended with error code ${code}. The code alone does not explain the cause. Open technical details for the recorded information.`,tone:'danger',icon:'error'};
    }
    case 'process.output':return {title:p.stream==='STDERR'?'Diagnostic output':'Agent output',description:p.stream==='STDERR'?'The agent program wrote diagnostic output. This alone does not mean it failed.':'The agent program recorded output while working.',tone:'muted',icon:'output'};
    case 'tool.started':return {title:`Using ${tool}`,description:'The agent started a tool action.',tone:'neutral',icon:'tool'};
    case 'tool.executed':return {title:`${tool} completed`,description:'This tool action finished successfully.',tone:'success',icon:'check'};
    case 'tool.failed':return {title:`${tool} failed`,description:'This tool action reported an error. The agent may continue with another approach.',tone:'danger',icon:'error'};
    case 'telemetry.context.window.updated':return {title:'Conversation context updated',description:'The agent estimated how much conversation context it is using. Token counts are available in technical details.',tone:'muted',icon:'context'};
    default:return {title:'Agent progress',description:'The agent recorded a progress update. The original event is available in technical details.',tone:'neutral',icon:'progress'};
  }
}
export function activityDetails(event:EventRow){
  // Preserve the entire recorded payload, including process output and tool arguments.
  return JSON.stringify({event:event.type,source:event.source,payload:event.payload},null,2);
}
