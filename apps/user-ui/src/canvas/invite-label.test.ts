import {describe,expect,it} from 'vitest';
import {inviteLabel,startLabel} from './invite-label';

const card=(over:Partial<{title:string;access:string;manageable:boolean;members:string[]}>={})=>({title:'Launch',access:'open',manageable:true,members:['Pip'],...over});

describe('inviteLabel',()=>{
  it('names the agent and the chat',()=>{ expect(inviteLabel({agent:'Moss',card:card()})).toBe('Invite Moss to "Launch"'); });
  it('says when the agent is already in the chat',()=>{ expect(inviteLabel({agent:'Pip',card:card()})).toBe('Pip is already here'); });
  it('refuses chats the person cannot manage, locked or unavailable',()=>{
    for(const over of [{manageable:false},{access:'locked'},{access:'unavailable'}])
      expect(inviteLabel({agent:'Moss',card:card(over)})).toBe("You can't add agents to this chat");
  });
});

describe('startLabel',()=>{
  it('offers a chat with the agent on empty canvas',()=>{ expect(startLabel('Moss')).toBe('Start a chat with Moss'); });
  it('names the area the chat would join',()=>{ expect(startLabel('Moss','Research')).toBe('Start a chat with Moss in Research'); });
  it('leaves out a blank area title',()=>{ expect(startLabel('Moss','')).toBe('Start a chat with Moss'); });
});
