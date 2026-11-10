import {describe,it,expect} from 'vitest';
import {buildTimeline} from './timeline';
import {agentFolds,foldAgentTimeline} from './agent-folds';
import type {EventRow} from '../types';
const at=new Date('2026-11-10T12:00:00Z').getTime();
const message=(id:string,source='agent:A',offset=0):EventRow=>({id,type:'message.created',source,channelId:'room',createdAt:at+offset,payload:{text:id}});
const timeline=(events:EventRow[])=>buildTimeline(events,{currentUsername:'owner'});
describe('agent message folding',()=>{
 it('leaves one or two messages visible, folds three regardless of author',()=>{
  expect(agentFolds(timeline([message('a'),message('b','agent:B',1)]))).toEqual([]);
  const items=timeline([message('a'),message('b','agent:B',1),message('c','agent:C',2)]);
  const folded=foldAgentTimeline(items,new Set(),null);
  expect(folded.items.map(item=>item.id)).toEqual(['c']);
  expect(folded.controls.get('c')?.fold.messageIds).toEqual(['a','b','c']);
  expect(foldAgentTimeline(items,new Set(['a']),null).items).toEqual(items);
 });
 it('lists distinct participants in first appearance order, including the latest author',()=>{
  const items=timeline([message('a'),message('b','agent:B',1),message('c','agent:A',2),message('d','agent:C',3)]);
  expect(agentFolds(items)[0].agentNames).toEqual(['A','B','C']);
 });
 it('human and system messages break runs',()=>{
  for(const source of ['human:owner','system:notice']){
   expect(agentFolds(timeline([message('a'),message('b','agent:B',1),message('break',source,2),message('c','agent:C',3)]))).toEqual([]);
  }
 });
 it('retains the newest message as live replies arrive and preserves an expanded group',()=>{
  const first=timeline([message('a'),message('b','agent:B',1),message('c','agent:C',2)]);
  const next=[...first,...timeline([message('d','agent:A',3)])];
  expect(foldAgentTimeline(next,new Set(),null).items.map(item=>item.id)).toEqual(['d']);
  expect(foldAgentTimeline(next,new Set(['a']),null).items).toEqual(next);
 });
 it('reveals a linked hidden message and leaves source data unchanged',()=>{
  const items=timeline([message('a'),message('b','agent:B',1),message('c','agent:C',2)]);
  expect(foldAgentTimeline(items,new Set(),'b').items).toEqual(items);
  expect(foldAgentTimeline(items,new Set(),'c').items.map(item=>item.id)).toEqual(['c']);
  expect(items).toHaveLength(3);
 });
 it('keeps activity with its message without counting it toward the threshold',()=>{
  const items=timeline([message('a'),{...message('tool','agent:A',1),type:'tool.executed',payload:{tool:'search',output:'done'}},message('b','agent:B',2),message('c','agent:C',3)]);
  const folded=foldAgentTimeline(items,new Set(),null);
  expect(folded.items.map(item=>item.id)).toEqual(['c']);
  expect(folded.redirects.get('a')).toBe('c');
 });
 it('does not fold across day or detached-history boundaries',()=>{
  expect(agentFolds(timeline([message('a'),message('b','agent:B',1),message('c','agent:C',86400000)]))).toEqual([]);
  const items=timeline([message('a'),message('b','agent:B',1),message('c','agent:C',2)]);
  items[0]={...items[0],meta:{...items[0].meta,detached:true}};
  expect(agentFolds(items)).toEqual([]);
 });
});
