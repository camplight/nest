// What can leave the page (spec 7.5.2, 7.2.2, 5.6). Reads only kind, meta.authorName, meta.displayAt, text and
// attachments of message items and only events.length of activity items: event payloads are never serialised.
import type {TimelineItem} from './timeline';

// A sortable stamp in the given zone (the reader's own when unset): YYYY-MM-DD HH:MM.
function stamp(ts:number,timeZone?:string):string{
 const parts=new Intl.DateTimeFormat('en-GB',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'})
  .formatToParts(new Date(ts));
 const part=(type:Intl.DateTimeFormatPartTypes)=>parts.find(entry=>entry.type===type)?.value??'';
 return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
}
const linkLabel=(name:string)=>name.replace(/[\\[\]]/g,'\\$&');

export function chatToMarkdown(items:readonly TimelineItem[],opts:{channelLabel:string;timeZone?:string}):string{
 const blocks=[`# ${opts.channelLabel}`];
 for(const item of items){
  if(item.kind==='activity'){
   const count=item.events.length;
   blocks.push(`_Agent activity: ${count} ${count===1?'event':'events'}_`);
   continue;
  }
  const lines=[`**${item.meta.authorName}** · ${stamp(item.meta.displayAt,opts.timeZone)}`];
  if(item.text)lines.push(item.text);
  for(const attachment of item.attachments)lines.push(`[${linkLabel(attachment.name)}](/api/files/${encodeURIComponent(attachment.fileId)})`);
  blocks.push(lines.join('\n'));
 }
 return blocks.join('\n\n')+'\n';
}

// The existing ?message= deep link: every other param stays, in its order.
export function messageLink(eventId:string,href:string):string{
 const url=new URL(href);
 url.searchParams.set('message',eventId);
 return url.toString();
}
