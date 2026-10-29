// The working row of one active agent turn (spec 7.5.1): the agent's portrait and name with its latest progress text.
// The look follows thread.aui.tsx's assistant message with its running indicator at @assistant-ui/react@0.15.31.
import {AgentAvatar} from '../components/AgentAvatar';
import {CircleAlertIcon} from 'lucide-react';
import type {WorkingTurn} from './working';

export function WorkingRow({turn,activityUnavailable,onReview}:{turn:WorkingTurn;activityUnavailable?:boolean;onReview():void}):JSX.Element|null{
 // Only the whitelisted progress text reaches the page, never tool data (anti-goal 5.6).
 return <div role="status" data-aui-quote-selectable="false" data-agent={turn.agent} data-turn-state={turn.interrupted?'interrupted':activityUnavailable?'unavailable':'working'}
  className="working-row mb-2 flex w-full max-w-3xl min-w-0 gap-3 self-start rounded-xl px-2 py-1 animate-in fade-in slide-in-from-bottom-1 duration-200">
  <div className="w-8 shrink-0 pt-0.5"><AgentAvatar name={turn.agent} size={32}/></div>
  <div className="min-w-0 flex-1">
   <div className="flex min-w-0 items-center gap-2">
    <strong className="min-w-0 text-sm font-semibold leading-5 text-foreground [overflow-wrap:anywhere]">{turn.agent}</strong>
    {turn.interrupted||activityUnavailable?<CircleAlertIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground"/>:<span aria-hidden="true" className="flex items-center gap-1">
     {['[animation-delay:0ms]','[animation-delay:150ms]','[animation-delay:300ms]'].map(delay=>
      <span key={delay} className={`size-1.5 rounded-full bg-muted-foreground/60 animate-pulse ${delay}`}/>)}
    </span>}
   </div>
   {turn.interrupted?<p className="m-0 mt-0.5 text-sm leading-6 text-muted-foreground">Interrupted · outcome unknown. <button type="button" onClick={onReview} className="text-foreground underline underline-offset-2">Review request</button></p>
    :activityUnavailable?<p className="m-0 mt-0.5 text-sm leading-6 text-muted-foreground">Activity unavailable</p>
    :turn.progressText
    ?<p className="trace-progress m-0 mt-0.5 text-sm leading-6 text-muted-foreground whitespace-pre-wrap [overflow-wrap:anywhere]">{turn.progressText}</p>
    :<p className="working-row-placeholder m-0 mt-0.5 text-sm leading-6 text-muted-foreground">Working…</p>}
  </div>
 </div>;
}
