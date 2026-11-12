import {describe,expect,it} from 'vitest';
import type {SelectedMention} from '@nest/schemas';
import {ApiError} from './api';
import {NOT_SCHEDULED_CHAT_FULL,NOT_SCHEDULED_NO_ACCESS,NOT_SCHEDULED_OTHER,NOT_SCHEDULED_TOO_LONG,leadAgent,notScheduledText,promptTooLong,ruleKey,schedulePrompt,typedSchedule} from './dock-schedule';

const at=(text:string,name:string,kind:'AGENT'|'HUMAN'='AGENT'):SelectedMention=>{const start=text.indexOf('@'+name);return {kind,name,start,end:start+name.length+1};};
// Wednesday 2026-11-11, 12:00 in Sofia.
const now=Date.UTC(2026,10,11,10);
const id='22222222-2222-4222-8222-222222222222';

describe('typed schedules in the bottom box',()=>{
  it('reads the brief\'s example: the rule, Pip as the lead and the prompt without the mention',()=>{
    const text='@Pip every Monday at 9 post the recap';
    expect(typedSchedule({id,text,mentions:[at(text,'Pip')],assistant:'Helper',now,tz:'Europe/Sofia'}))
      .toEqual({id,rule:{kind:'weekly',days:[0],time:'09:00'},agent:'Pip',prompt:'every Monday at 9 post the recap'});
  });
  it('strips picked and typed mentions, including names with @ and dots, and collapses whitespace',()=>{
    const text='Ask  @naska@example.com and @Pip,\n every day   to check @Rook';
    expect(schedulePrompt(text,[at(text,'naska@example.com','HUMAN')])).toBe('Ask and every day to check');
    expect(schedulePrompt('mail bob@example.com every day',[])).toBe('mail bob@example.com every day');
  });
  it('leads with the first mentioned agent, else the assistant, else nobody',()=>{
    const text='@mate and @Rook then @Pip every day';
    expect(leadAgent(text,[at(text,'Pip'),at(text,'mate','HUMAN'),at(text,'Rook')],'Helper')).toBe('Rook');
    expect(leadAgent('@mate every day',[at('@mate every day','mate','HUMAN')],'Helper')).toBe('Helper');
    expect(leadAgent('every day',[],null)).toBeNull();
    // A mention whose text was edited away no longer counts.
    expect(leadAgent('@Pi every day',[{kind:'AGENT',name:'Pip',start:0,end:4}],undefined)).toBeNull();
  });
  it('hides a dismissed rule until the text asks for another one',()=>{
    const dismissed=ruleKey({kind:'weekly',days:[0],time:'09:00'});
    expect(typedSchedule({id,text:'every Monday at 9',mentions:[],dismissed,now,tz:'UTC'})).toBeNull();
    expect(typedSchedule({id,text:'every Monday at 10',mentions:[],dismissed,now,tz:'UTC'})?.rule).toEqual({kind:'weekly',days:[0],time:'10:00'});
    expect(typedSchedule({id,text:'every time',mentions:[],now,tz:'UTC'})).toBeNull();
  });
  it('says why a repeat was not saved in people\'s words, never the API\'s validation text',()=>{
    const api=(status:number,error:string)=>new ApiError(JSON.stringify({error}),status);
    expect(notScheduledText(api(400,'String must contain at most 4000 character(s)'))).toBe(NOT_SCHEDULED_TOO_LONG);
    expect(NOT_SCHEDULED_TOO_LONG).toBe('Not scheduled: the message is too long to repeat.');
    expect(notScheduledText(api(400,'A chat can have at most 10 schedules'))).toBe('Not scheduled: this chat already has 10 schedules.');
    expect(NOT_SCHEDULED_CHAT_FULL).toBe('Not scheduled: this chat already has 10 schedules.');
    expect(notScheduledText(api(403,'You need to be able to post in this chat'))).toBe(NOT_SCHEDULED_NO_ACCESS);
    expect(NOT_SCHEDULED_NO_ACCESS).toBe('Not scheduled: you can\'t schedule in this chat.');
    for(const error of [api(409,'Add Pip to the chat first'),api(400,'Unknown time zone'),api(502,'The engine is unavailable.'),new TypeError('Failed to fetch')])
      expect(notScheduledText(error)).toBe('Not scheduled: set it up from the chat\'s clock instead.');
    expect(NOT_SCHEDULED_OTHER).toBe('Not scheduled: set it up from the chat\'s clock instead.');
    expect([promptTooLong('x'.repeat(4000)),promptTooLong(' x'.repeat(2001))]).toEqual([false,true]);
  });
});
