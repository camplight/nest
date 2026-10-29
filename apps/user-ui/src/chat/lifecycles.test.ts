import {describe,it,expect} from 'vitest';
import {agentLifecycleStart,fetchAgentStarts,mergeAgentStarts} from './lifecycles';
import type {EventRow} from '../types';
const event=(extra:Partial<EventRow>={}):EventRow=>({id:'boot',type:'agent.lifecycle.started',source:'system:runner',createdAt:2000,payload:{targetAgentName:'Pip',text:'not retained',startedAt:999999},...extra});
describe('agent lifecycle evidence',()=>{
 it('uses the engine timestamp and trusts only runner lifecycle sources',()=>{
  expect(agentLifecycleStart(event())).toEqual({agent:'Pip',at:2000});
  for(const extra of [{source:'human:owner'},{type:'agent.turn.phase'},{createdAt:undefined},{payloadTruncated:true},{payload:[]}])expect(agentLifecycleStart(event(extra))).toBeNull();
  expect(agentLifecycleStart(event({type:'wrapper.lifecycle.started',source:'system:runner:wrapper'}))).toEqual({agent:'Pip',at:2000});
 });
 it('retains only the newest timestamps, without idle-poll object churn',()=>{
  const starts={Pip:2000};expect(mergeAgentStarts(starts,{Pip:1000})).toBe(starts);
  expect(mergeAgentStarts(starts,{Pip:3000,Rex:2500})).toEqual({Pip:3000,Rex:2500});expect(starts).toEqual({Pip:2000});
 });
 it('bounds both reads and discards cross-channel content',async()=>{
  const urls:string[]=[];
  const starts=await fetchAgentStarts(async<T>(url:string)=>{urls.push(url);return [event(),event({createdAt:1000}),event({source:'human:owner',createdAt:3000})] as T;});
  expect(urls).toHaveLength(2);expect(urls.every(url=>url.includes('limit=100&order=desc')&&!url.includes('agentName='))).toBe(true);
  expect(starts).toEqual({Pip:2000});expect(JSON.stringify(starts)).not.toContain('not retained');
 });
 it('supports agent names that match object properties without changing prototypes',async()=>{
  const starts=await fetchAgentStarts(async<T>()=>[event({payload:{targetAgentName:'__proto__'}}),event({payload:{targetAgentName:'constructor'}})] as T);
  expect(Object.getPrototypeOf(starts)).toBeNull();
  const merged=mergeAgentStarts({},starts);
  expect(merged['__proto__']).toBe(2000);expect(merged.constructor).toBe(2000);
 });
});
