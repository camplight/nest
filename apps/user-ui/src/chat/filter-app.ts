// The Apps here filter: what a chat's timeline shows while one app is chosen. Pure.
import {classifyToolEvent} from '../app-activity';
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
