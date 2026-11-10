import {describe,it,expect} from 'vitest';
import {activity,activityDetails,activeAgentProgress} from './activity';
import type {EventRow} from './types';
const event=(type:string,payload:unknown)=>({id:'fixture',type,payload,source:'agent:Demo',createdAt:1,channelId:'demo'} as EventRow);
describe('activity status meaning',()=>{
 it('distinguishes process success, failure and missing status',()=>{
  expect(activity(event('process.exited',{exitCode:0})).tone).toBe('success');
  expect(activity(event('process.exited',{exitCode:1}))).toMatchObject({tone:'danger',icon:'error'});
  expect(activity(event('process.exited',{})).tone).toBe('muted');
 });
 it('does not equate diagnostic output with a failed response',()=>{
  expect(activity(event('process.output',{stream:'STDERR',text:'warning'})).tone).toBe('muted');
 });
 it('retains original event data in technical details',()=>{
  const row=event('tool.failed',{tool:'Search',args:{query:'demo'},error:{code:'offline'}});
  expect(JSON.parse(activityDetails(row))).toEqual({event:row.type,source:row.source,payload:row.payload});
 });
});

describe('app calls in the timeline',()=>{
 const call=(command:string,type='tool.executed')=>({...event(type,{tool:'shell_run',args:{command},output:'SECRET-OUT'}),source:'agent:Pip'});
 const send=call('node scripts/connections.mjs execute c1 GMAIL_SEND_EMAIL < a.json');
 it('names the agent, app, action and whether it read or changed',()=>{
  expect(activity(send).title).toBe('Pip · Gmail · Send email · changed');
  expect(activity(call('node scripts/connections.mjs execute c1 GMAIL_FETCH_EMAILS < a.json')).title).toBe('Pip · Gmail · Fetch emails · read');
 });
 it('keeps the tone of the event phase',()=>{
  expect(activity(call('gh pr view 1 -R acme/web','tool.failed')).tone).toBe('danger');
 });
 it('shows only tool, time, agent, kind and label in the details',()=>{
  const text=activityDetails(send);
  expect(JSON.parse(text)).toEqual({tool:'shell_run',time:'1970-01-01T00:00:00.001Z',agent:'Pip',kind:'change',label:null});
  for(const leak of ['a.json','connections.mjs','SECRET-OUT','args','output'])expect(text).not.toContain(leak);
  expect(JSON.parse(activityDetails(call('gh pr view 1 -R acme/web'))).label).toBe('acme/web');
 });
 it('leaves other tools and shell commands as they were',()=>{
  const ls=call('ls -la');
  expect(activity(ls).title).toBe('shell_run completed');
  expect(JSON.parse(activityDetails(ls)).payload.args.command).toBe('ls -la');
 });
});

describe('compact wrapped progress',()=>{
 const progress=(id:string,triggerEventId='turn',source='agent:Demo')=>({...event('agent.turn.phase',{phase:'codex-progress',text:'Waiting for checks.',triggerEventId}),id,source});
 it('keeps only the latest update per turn across interleaved human messages',()=>{
  const rows=[progress('old'),event('message.created',{text:'Any update?'}),progress('latest'),progress('other','other-turn','agent:Other')];
  expect([...activeAgentProgress(rows)]).toEqual(['latest','other']);
  rows.push(event('agent.turn.completed',{triggerEventId:'turn'}));
  expect([...activeAgentProgress(rows)]).toEqual(['other']);
 });
 it('clears failed or completed wrapper updates, including late transport arrivals',()=>{
  const done={...event('wrapper.turn.failed',{targetAgentName:'Demo',triggerEventId:'turn'}),source:'system:runner:wrapper'};
  expect([...activeAgentProgress([progress('old'),done,progress('late')])]).toEqual([]);
 });
 it('does not reuse a previous turn update or expose arbitrary phase payloads',()=>{
  expect([...activeAgentProgress([progress('old'),event('agent.turn.started',{triggerEventId:'next'}),event('agent.turn.phase',{text:'private detail'})])]).toEqual([]);
 });
 it('shows progress when the engine retries a previously failed trigger',()=>{
  expect([...activeAgentProgress([event('agent.turn.failed',{triggerEventId:'turn'}),event('agent.turn.started',{triggerEventId:'turn'}),progress('retry')])]).toEqual(['retry']);
 });
});
