import type { Agent, ChannelParticipant } from './types';
import {findTrigger} from './chat/triggers';
export type MentionCandidate = {id:string; name:string; kind:'Agent'|'Person'; inConversation:boolean; assistantOwner?:string;inviteBlockedReason?:string};
export type MentionQuery = {start:number; end:number; query:string};
export function findMention(value:string, caret:number, selectionEnd=caret): MentionQuery | null {
  const trigger=findTrigger(value,caret,selectionEnd);
  return trigger?.trigger==='@' ? {start:trigger.start,end:trigger.end,query:trigger.query} : null;
}
const normalize=(s:string)=>s.normalize('NFKD').replace(/\p{M}/gu,'').toLocaleLowerCase();
export function mentionCandidates(agents:Agent[],humans:{username:string}[],participants:ChannelParticipant[]): MentionCandidate[] {
  const members=new Set(participants.map(p=>`${p.subscriberType.toUpperCase()}:${p.subscriberId}`));
  const result=new Map<string,MentionCandidate>();
  const add=(name:string,kind:'Agent'|'Person')=>{
    if (!name || /[\r\n\0]/.test(name)) return;
    const id=`${kind==='Agent'?'AGENT':'HUMAN'}:${name}`;
    result.set(id,{id,name,kind,inConversation:members.has(id)});
  };
  agents.forEach(a=>add(a.name,'Agent'));
  humans.forEach(h=>add(h.username,'Person'));
  participants.forEach(p=>{if(p.subscriberType.toUpperCase()==='AGENT')add(p.subscriberId,'Agent');if(p.subscriberType.toUpperCase()==='HUMAN')add(p.subscriberId,'Person');});
  return [...result.values()];
}
export function rankMentions(candidates:MentionCandidate[],query:string) {
  const q=normalize(query);
  function score(name:string) {
    const n=normalize(name);
    if (!q) return 0;
    if (n===q) return 0;
    if (n.startsWith(q)) return 1;
    const index=n.indexOf(q);
    if(index>=0)return 10+index;
    let cursor=0, gaps=0;
    for(const char of q){const next=n.indexOf(char,cursor);if(next<0)return Infinity;gaps+=next-cursor;cursor=next+1;}
    return 100+gaps;
  }
  return candidates.map(candidate=>({candidate,score:score(candidate.name)})).filter(x=>Number.isFinite(x.score))
    .sort((a,b)=>a.score-b.score || Number(b.candidate.inConversation)-Number(a.candidate.inConversation) || a.candidate.name.localeCompare(b.candidate.name) || a.candidate.kind.localeCompare(b.candidate.kind))
    .map(x=>x.candidate);
}
export function insertMention(value:string,mention:MentionQuery,name:string) {
  // Replace the unfinished token, preserving punctuation and text after it.
  const remainder=value.slice(mention.end);
  const end=mention.end+(remainder.match(/^[\p{L}\p{N}_-]*/u)?.[0].length ?? 0);
  const after=value.slice(end);
  const inserted=`@${name}${after && /^[\s.,!?;:)\]}]/.test(after) ? '' : ' '}`;
  return {value:value.slice(0,mention.start)+inserted+after,caret:mention.start+inserted.length};
}

/** Keep selected identities only while their exact text survives an edit. */
export function reconcileMentions(before:string,after:string,mentions:import('@nest/schemas').SelectedMention[]) {
 let start=0;while(start<before.length&&start<after.length&&before[start]===after[start])start++;
 let oldEnd=before.length,newEnd=after.length;while(oldEnd>start&&newEnd>start&&before[oldEnd-1]===after[newEnd-1]){oldEnd--;newEnd--;}
 const delta=newEnd-oldEnd;
 return mentions.flatMap(m=>{
  const next=m.end<=start?m:m.start>=oldEnd?{...m,start:m.start+delta,end:m.end+delta}:null;
  return next&&after.slice(next.start,next.end)==='@'+next.name?[next]:[];
 });
}
