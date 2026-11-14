import {describe,it,expect} from 'vitest';
import {activity,activityDetails,activeAgentProgress,connectionActionLine,turnFailureText} from './activity';
import type {EventRow} from './types';
const event=(type:string,payload:unknown)=>({id:'fixture',type,payload,source:'agent:Demo',createdAt:1,channelId:'demo'} as EventRow);
describe('activity status meaning',()=>{
 it('distinguishes process success, failure and missing status',()=>{
  expect(activity(event('process.exited',{exitCode:0})).tone).toBe('success');
  expect(activity(event('process.exited',{exitCode:1}))).toMatchObject({tone:'danger',icon:'error'});
  expect(activity(event('process.exited',{})).tone).toBe('muted');
 });
 it('names stopped turns and summarized history',()=>{
  expect(activity(event('agent.turn.completed',{triggerEventId:'turn',cancelled:true,noReply:true}))).toMatchObject({title:'Stopped',tone:'muted',icon:'stop'});
  expect(activity(event('agent.turn.completed',{triggerEventId:'turn'})).title).toBe('Response completed');
  expect(activity(event('agent.turn.cancel_requested',{targetAgentName:'Demo',triggerEventId:'turn'})).title).toBe('Stop requested');
  expect(activity(event('agent.context.compacted',{summary:'Earlier chat.'}))).toMatchObject({title:'Summarized earlier messages',icon:'context'});
 });
 it('does not equate diagnostic output with a failed response',()=>{
  expect(activity(event('process.output',{stream:'STDERR',text:'warning'})).tone).toBe('muted');
 });
 it('retains original event data in technical details',()=>{
  const row=event('tool.failed',{tool:'Search',args:{query:'demo'},error:{code:'offline'}});
  expect(JSON.parse(activityDetails(row))).toEqual({event:row.type,source:row.source,payload:row.payload});
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

describe('connection action lines',()=>{
 const action=(outcome:string,extra:Record<string,unknown>={})=>({id:'a',type:'telemetry.nest.connection.action',source:'system:nest-connections',createdAt:1,channelId:'demo',
  payload:{agentName:'NikiPA',connectionId:'c',app:'miro',tool:'MIRO_CREATE_IMAGE_ITEM_FROM_URL',title:'Create image item from URL',change:'create',outcome,requestId:'r',...extra}} as EventRow);
 it('names the app and action for each outcome',()=>{
  expect(connectionActionLine(action('ok'))).toEqual({app:'miro',text:'Miro · Create image item from URL',tone:'neutral'});
  expect(connectionActionLine(action('failed'))).toEqual({app:'miro',text:'Miro · Create image item from URL failed',tone:'danger'});
  expect(connectionActionLine(action('unknown'))).toEqual({app:'miro',text:'Miro · Create image item from URL may not have finished. Check Miro before trying again',tone:'muted'});
 });
 it('ignores malformed and unrelated events',()=>{
  expect(connectionActionLine(action('ok',{title:''}))).toBeNull();
  expect(connectionActionLine(action('maybe'))).toBeNull();
  expect(connectionActionLine(event('tool.executed',{tool:'Search'}))).toBeNull();
 });
 it('titles the event inside Details',()=>{
  expect(activity(action('ok')).title).toBe('Miro · Create image item from URL');
 });
});
describe('turn failures in plain words',()=>{
 const failed=(error:unknown)=>event('agent.turn.failed',{triggerEventId:'t',error});
 it('explains known failures',()=>{
  expect(turnFailureText(failed('AI_APICallError: Invalid image or video input'),'NikiPA')).toBe("NikiPA couldn't finish: this model can't read images.");
  expect(turnFailureText(failed('AI_APICallError: Account x is suspended, possibly due to reaching the monthly spending limit. Please go to https://fireworks.ai/account/billing for more information.'),'NikiPA'))
   .toBe("NikiPA couldn't finish: the model provider account is suspended or out of credit.");
  expect(turnFailureText(failed('Error: Wrapped runtime failed for Fen: Fireworks request did not complete.\n'),'Fen')).toBe("Fen couldn't finish: the model request didn't complete.");
  expect(turnFailureText(failed('Error: Wrapped runtime failed for Fen: Fireworks returned no reply text.\n'),'Fen')).toBe("Fen couldn't finish: the model returned no reply.");
 });
 it('falls back to the first sentence of an unknown error',()=>{
  expect(turnFailureText(failed('TypeError: Something odd happened. More detail here.'),'Pip')).toBe("Pip couldn't finish: Something odd happened.");
  expect(turnFailureText(failed({code:'x'}),'Pip')).toBe("Pip couldn't finish this turn.");
  expect(turnFailureText(failed('x'.repeat(400)),'Pip').length).toBeLessThanOrEqual(180);
 });
});
