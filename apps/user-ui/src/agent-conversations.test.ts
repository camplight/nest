import {describe,it,expect} from 'vitest';
import {conversationAgent} from './agent-conversations';
import type {Channel} from './types';
const chat:Channel={id:'chat',name:'Planning',visibility:'PRIVATE',participants:[{subscriberType:'HUMAN',subscriberId:'alice'},{subscriberType:'AGENT',subscriberId:'helper'}]};
describe('agent conversation grouping',()=>{
 it('groups direct and named private chats for the current human',()=>{expect(conversationAgent(chat,'alice','alice-id')).toBe('helper');expect(conversationAgent({...chat,kind:'HUMAN_AGENT_DM'},'alice','alice-id')).toBe('helper');});
 it('keeps public, shared, group, and other humans’ chats outside the private tree',()=>{
  expect(conversationAgent({...chat,visibility:'PUBLIC'},'alice','alice-id')).toBeNull();
  expect(conversationAgent({...chat,shares:[{viewerType:'HUMAN',viewerId:'bob'}]},'alice','alice-id')).toBeNull();
  expect(conversationAgent({...chat,participants:[...chat.participants!,{subscriberType:'HUMAN',subscriberId:'bob'}]},'alice','alice-id')).toBeNull();
  expect(conversationAgent(chat,'bob','bob-id')).toBeNull();
 });
});
