import {describe,expect,it} from 'vitest';
import {rosterChange} from './members';
import type {Channel,EventRow} from '../types';

const channel:Channel={id:'c1',name:'Project',participants:[{subscriberType:'HUMAN',subscriberId:'admin'},{subscriberType:'AGENT',subscriberId:'NikiPA'}]};
const ev=(type:string,source:string,payload:Record<string,unknown>,channelId='c1'):EventRow=>({id:'e',type,source,channelId,payload,createdAt:1});

describe('rosterChange',()=>{
 it('names the chat an agent added someone to',()=>{
  expect(rosterChange(ev('tool.executed','agent:NikiPA',{tool:'events_channel_participant_add',args:{channelId:'c2',subscriberType:'AGENT',subscriberId:'Wren'}}),[channel])).toBe('c2');
 });
 it('names the chat someone was removed from',()=>{
  expect(rosterChange(ev('tool.executed','agent:NikiPA',{tool:'events_channel_participant_remove',args:{channelId:'c1'}}),[channel])).toBe('c1');
 });
 it('falls back to the event chat when the tool names none',()=>{
  expect(rosterChange(ev('tool.executed','agent:NikiPA',{tool:'events_channel_participant_add',args:{}}),[channel])).toBe('c1');
 });
 it('ignores a failed add',()=>{
  expect(rosterChange(ev('tool.failed','agent:NikiPA',{tool:'events_channel_participant_add',args:{channelId:'c1'}}),[channel])).toBeNull();
 });
 it('notices a message from an agent or person the chat does not list yet',()=>{
  expect(rosterChange(ev('message.created','agent:Wren',{text:'hi'}),[channel])).toBe('c1');
  expect(rosterChange(ev('message.created','human:sarah',{text:'hi'}),[channel])).toBe('c1');
 });
 it('ignores messages from members, the system and unknown chats',()=>{
  expect(rosterChange(ev('message.created','agent:NikiPA',{text:'hi'}),[channel])).toBeNull();
  expect(rosterChange(ev('message.created','system:runner',{text:'hi'}),[channel])).toBeNull();
  expect(rosterChange(ev('message.created','agent:Wren',{text:'hi'},'other'),[channel])).toBeNull();
 });
 it('ignores other tools',()=>{
  expect(rosterChange(ev('tool.executed','agent:NikiPA',{tool:'events_channel_participants',args:{channelId:'c1'}}),[channel])).toBeNull();
 });
});
