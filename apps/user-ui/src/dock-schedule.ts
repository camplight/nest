// Typed schedules in the canvas bottom box (Phase 3, Task 12): the rule a draft asks for, the chip's key, the agent that
// runs it and the prompt each run posts. Pure; the box and the canvas decide what to show and when to save.
import {parseScheduleText,type ScheduleRule,type SelectedMention} from '@nest/schemas';

/** What the bottom box hands the canvas after a send: the rule, its lead agent (none in the chat: null) and the prompt. */
export type TypedSchedule = {rule:ScheduleRule;agent:string|null;prompt:string};

/** The browser's IANA time zone; a typed rule and its saved schedule use the same one. */
export function browserZone(){try{return Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';}catch{return 'UTC';}}

/** The rule's identity: ✕ hides the chip until the text asks for a different rule. */
export const ruleKey=(rule:ScheduleRule)=>JSON.stringify(rule);

/** The text with its @mentions removed: picked mentions by position, then any other `@Name` token; whitespace collapsed. */
export function schedulePrompt(text:string,mentions:SelectedMention[]){
  let plain=text;
  for(const mention of [...mentions].sort((a,b)=>b.start-a.start))if(text.slice(mention.start,mention.end)==='@'+mention.name)plain=plain.slice(0,mention.start)+' '+plain.slice(mention.end);
  return plain.replace(/(^|\s)@\S+/g,'$1').replace(/\s+/g,' ').trim();
}

/** The first agent mentioned in the text, else the assistant agent joining the chat, else null. */
export function leadAgent(text:string,mentions:SelectedMention[],assistant:string|null|undefined){
  const first=[...mentions].sort((a,b)=>a.start-b.start).find(m=>m.kind==='AGENT'&&text.slice(m.start,m.end)==='@'+m.name);
  return first?.name??assistant??null;
}

/** The schedule a draft asks for, unless its chip was dismissed. */
export function typedSchedule({text,mentions,assistant,dismissed,now,tz}:{text:string;mentions:SelectedMention[];assistant?:string|null;dismissed?:string;now:number;tz:string}):TypedSchedule|null{
  const rule=parseScheduleText(text,now,tz);
  if(!rule||ruleKey(rule)===dismissed)return null;
  return {rule,agent:leadAgent(text,mentions,assistant),prompt:schedulePrompt(text,mentions)};
}
