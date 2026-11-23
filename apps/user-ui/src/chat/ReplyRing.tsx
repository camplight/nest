// Hovering the agent's avatar on a finished reply (or tapping it on a touch screen) shows the working ring of the turn
// behind it, as a still picture.
import {useMemo,type ReactNode} from 'react';
import {HoverCard} from 'radix-ui';
import type {EventRow} from '../types';
import {finishedTurn} from './ring';
import {WorkingRing} from './WorkingRing';
import {useChatPortal} from './ui/portal';
import {useTapCard} from './tap-card';
import './tap-hint.css';

export function ReplyRing({agent,events,children}:{agent:string;events:readonly EventRow[];children:ReactNode}):JSX.Element{
 const container=useChatPortal();
 const turn=useMemo(()=>finishedTurn(events,agent),[events,agent]);
 const tap=useTapCard();
 if(!turn||!container)return <>{children}</>;
 return <HoverCard.Root openDelay={250} closeDelay={100} open={tap.open} onOpenChange={tap.onOpenChange}>
  <HoverCard.Trigger asChild {...tap.triggerProps}><div className="reply-ring-trigger" data-agent={agent}>{children}</div></HoverCard.Trigger>
  <HoverCard.Portal container={container}>
   <HoverCard.Content side="top" align="start" sideOffset={6} collisionPadding={16}
    className="z-50 rounded-xl border border-border bg-popover p-4 pb-3 text-popover-foreground shadow-lg animate-in fade-in-0 zoom-in-95">
    <WorkingRing agent={agent} since={turn.since} events={events} finished={turn}/>
   </HoverCard.Content>
  </HoverCard.Portal>
 </HoverCard.Root>;
}
