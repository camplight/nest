// The working row of one active agent turn (spec 7.5.1): the agent's portrait and name with its latest progress text.
// The look follows thread.aui.tsx's assistant message with its running indicator at @assistant-ui/react@0.15.31.
import {AgentAvatar} from '../components/AgentAvatar';
import type {Agent} from '../types';
import type {WorkingTurn} from './working';

export function WorkingRow({turn}:{turn:WorkingTurn;agent?:Agent}):JSX.Element|null{
 // Only the whitelisted progress text reaches the page, never tool data (anti-goal 5.6).
 return <div role="status" data-aui-quote-selectable="false" data-agent={turn.agent}
  className="working-row mb-2 flex w-full max-w-3xl min-w-0 gap-3 self-start rounded-xl px-2 py-1 animate-in fade-in slide-in-from-bottom-1 duration-200">
  <div className="w-8 shrink-0 pt-0.5"><AgentAvatar name={turn.agent} size={32}/></div>
  <div className="min-w-0 flex-1">
   <div className="flex min-w-0 items-center gap-2">
    <strong className="min-w-0 text-sm font-semibold leading-5 text-foreground [overflow-wrap:anywhere]">{turn.agent}</strong>
    <span aria-hidden="true" className="flex items-center gap-1">
     {['[animation-delay:0ms]','[animation-delay:150ms]','[animation-delay:300ms]'].map(delay=>
      <span key={delay} className={`size-1.5 rounded-full bg-muted-foreground/60 animate-pulse ${delay}`}/>)}
    </span>
   </div>
   {turn.progressText
    ?<p className="trace-progress m-0 mt-0.5 text-sm leading-6 text-muted-foreground whitespace-pre-wrap [overflow-wrap:anywhere]">{turn.progressText}</p>
    :<p className="working-row-placeholder m-0 mt-0.5 text-sm leading-6 text-muted-foreground">Working…</p>}
  </div>
 </div>;
}
