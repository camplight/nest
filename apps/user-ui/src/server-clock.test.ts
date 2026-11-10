import {describe,expect,it} from 'vitest';
import {createServerClock} from './server-clock';
import {chatCalls,noteToolTimes} from './chat/AppsHere';
import type {EventRow} from './types';

const date=(ms:number)=>({headers:{get:(name:string)=>name==='date'?new Date(ms).toUTCString():null}});
describe('server clock',()=>{
 it('follows a realtime event both ways',()=>{
  let browser=100_000;
  const clock=createServerClock(()=>browser);
  clock.noteServerTime(160_000,{fresh:true});
  expect(clock.serverNow()).toBe(160_000);   // browser behind
  clock.noteServerTime(40_000,{fresh:true});
  expect(clock.serverNow()).toBe(40_000);    // browser ahead
 });
 it('lets seeded history only raise the offset',()=>{
  const clock=createServerClock(()=>100_000);
  clock.noteServerTime(40_000);
  expect(clock.offset()).toBe(0);
  clock.noteServerTime(130_000);
  expect(clock.offset()).toBe(30_000);
 });
 it('takes a quiet chat from the Date header alone, both ways',()=>{
  let browser=1_700_000_000_000;
  const clock=createServerClock(()=>browser);
  clock.noteResponseDate(date(browser+120_000));
  expect(clock.serverNow()).toBe(browser+120_000);
  clock.noteResponseDate(date(browser-300_000));
  expect(clock.serverNow()).toBe(browser-300_000);
  clock.noteResponseDate({headers:{get:()=>null}});
  clock.noteResponseDate({headers:{get:()=>'nonsense'}});
  expect(clock.offset()).toBe(-300_000);
  browser+=5_000;
  expect(clock.serverNow()).toBe(browser-300_000);
 });
});

describe('chat bar time',()=>{
 const tool=(type:string,createdAt:number):EventRow=>({id:`${type}${createdAt}`,type,source:'agent:Pip',channelId:'c',createdAt,payload:{tool:'shell_run',args:{command:'node scripts/connections.mjs execute c1 GMAIL_SEND_EMAIL < a.json'}}});
 it('turns a running call failed after 10 minutes of server time with no new events',()=>{
  const start=1_700_000_000_000;
  let browser=start-90_000;   // browser behind the server
  const clock=createServerClock(()=>browser);
  const events=[tool('tool.started',start)];
  noteToolTimes(events,clock);
  expect(chatCalls(events,clock.serverNow())[0].state).toBe('running');
  browser+=9*60_000;
  expect(chatCalls(events,clock.serverNow())[0].state).toBe('running');
  browser+=2*60_000;
  expect(chatCalls(events,clock.serverNow())[0].state).toBe('failed');
 });
 it('does not fail early when the browser runs ahead and the Date header says so',()=>{
  const start=1_700_000_000_000;
  const browser=start+20*60_000;   // browser 20 minutes ahead
  const clock=createServerClock(()=>browser);
  clock.noteResponseDate(date(start+60_000));
  expect(chatCalls([tool('tool.started',start)],clock.serverNow())[0].state).toBe('running');
 });
});
