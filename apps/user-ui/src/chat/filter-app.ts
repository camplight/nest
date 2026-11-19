// The Apps here filter: what a chat's timeline shows while one app is chosen. Pure.
import {classifyToolEvent} from '../app-activity';
import type {EventRow} from '../types';
import type {TimelineItem} from './timeline';

/**
 * With an app: only that app's tool.* events, as activity lines; messages and every other event are left out
 * (the chat then shows only what happened in that app). Without one the items come back untouched.
 */
export function filterTimelineByApp(items:TimelineItem[],app:string|null):TimelineItem[]{
 if(app===null)return items;
 const out:TimelineItem[]=[];
 for(const item of items){
  if(item.kind!=='activity')continue;
  const events=item.events.filter(event=>event.type.startsWith('tool.')&&classifyToolEvent(event)?.app===app);
  if(events.length)out.push({...item,events});
 }
 return out;
}

/** Whether the chosen app still has a call among the loaded events; without one the filtered thread would be blank. */
export function appFilterStays(app:string|null,events:EventRow[]):boolean{
 return app===null||events.some(event=>event.type.startsWith('tool.')&&classifyToolEvent(event)?.app===app);
}

/** The id of the person's newest message among the loaded events: a change means they sent one (the filter hides it). */
export function latestOwnMessageId(events:EventRow[],username:string):string|null{
 let latest:EventRow|null=null;
 for(const event of events)if(event.type==='message.created'&&event.source===`human:${username}`&&(!latest||(event.createdAt??0)>=(latest.createdAt??0)))latest=event;
 return latest?.id??null;
}
