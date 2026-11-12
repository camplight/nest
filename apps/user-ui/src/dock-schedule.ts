// Typed schedules in the canvas bottom box (Phase 3, Task 12): the rule a draft asks for, the chip's key, the agent that
// runs it and the prompt each run posts. Pure; the box and the canvas decide what to show and when to save.
import {MAX_SCHEDULES_PER_CHAT,MAX_SCHEDULE_PROMPT,parseScheduleText,type ScheduleRule,type SelectedMention} from '@nest/schemas';
import {ApiError} from './api';

/**
 * What the bottom box hands the canvas after a send: the schedule's id (the sent message's, so a second send of the
 * same draft cannot make a second schedule), the rule, its lead agent (none in the chat: null) and the prompt.
 */
export type TypedSchedule = {id:string;rule:ScheduleRule;agent:string|null;prompt:string};

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
export function typedSchedule({id,text,mentions,assistant,dismissed,now,tz}:{id:string;text:string;mentions:SelectedMention[];assistant?:string|null;dismissed?:string;now:number;tz:string}):TypedSchedule|null{
  const rule=parseScheduleText(text,now,tz);
  if(!rule||ruleKey(rule)===dismissed)return null;
  return {id,rule,agent:leadAgent(text,mentions,assistant),prompt:schedulePrompt(text,mentions)};
}

export const NOT_SCHEDULED_NO_AGENT='Not scheduled: mention an agent to run it.';
export const NOT_SCHEDULED_TOO_LONG='Not scheduled: the message is too long to repeat.';
export const NOT_SCHEDULED_CHAT_FULL=`Not scheduled: this chat already has ${MAX_SCHEDULES_PER_CHAT} schedules.`;
export const NOT_SCHEDULED_NO_ACCESS='Not scheduled: you can\'t schedule in this chat.';
export const NOT_SCHEDULED_OTHER='Not scheduled: set it up from the chat\'s clock instead.';
/** Why a typed repeat was not saved, in people's words: never the API's validation text. */
export function notScheduledText(error:unknown){
  if(!(error instanceof ApiError))return NOT_SCHEDULED_OTHER;
  let reason='';try{reason=String((JSON.parse(error.message) as {error?:unknown}).error??'');}catch{reason=error.message;}
  if(error.status===403)return NOT_SCHEDULED_NO_ACCESS;
  if(error.status===400&&/^A chat can have at most/.test(reason))return NOT_SCHEDULED_CHAT_FULL;
  if(error.status===400&&new RegExp(`at most ${MAX_SCHEDULE_PROMPT} character`).test(reason))return NOT_SCHEDULED_TOO_LONG;
  return NOT_SCHEDULED_OTHER;
}
/** A prompt over the API's limit is refused here, before any request. */
export const promptTooLong=(prompt:string)=>prompt.trim().length>MAX_SCHEDULE_PROMPT;
