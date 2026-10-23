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
 it('shows runtime-neutral wrapped progress alongside existing Codex progress',()=>{
  const wrapped={...event('agent.turn.phase',{phase:'wrapped-progress',text:'Running the tests.',triggerEventId:'claude-turn'}),id:'claude',source:'agent:Claude'};
  expect([...activeAgentProgress([progress('codex'),wrapped])]).toEqual(['codex','claude']);
 });
});
