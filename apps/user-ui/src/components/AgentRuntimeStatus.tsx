import './agent-runtime-status.css';

const states: Record<string, {tone:string; label:string}> = {
  RUNNING: {tone:'running',label:'Running'},
  STOPPED: {tone:'stopped',label:'Stopped'},
  CRASHED: {tone:'error',label:'Error'},
  STARTING: {tone:'starting',label:'Starting'},
};

export function AgentRuntimeStatus({state}:{state?:string}) {
  const status = state && Object.hasOwn(states,state) ? states[state] : {tone:'unknown',label:'Status unknown'};
  return <span className="agent-runtime-status" data-state={status.tone}>
    <i aria-hidden="true"/>{status.label}
  </span>;
}
