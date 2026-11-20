import {describe,expect,it} from 'vitest';
import {DEFAULT_CARD_WIDTH} from '@nest/schemas';
import {CARD_PLACE_HEIGHT,PLACE_GAP} from './loose';
import {agentDropTarget,newChatMembers,startFailed,startSpot} from './agent-drop';

describe('agentDropTarget',()=>{
  it('targets the card under the pointer, whatever its access',()=>{
    expect(agentDropTarget({cardId:'c1',areaId:'a1',canStart:true})).toEqual({kind:'card',channelId:'c1'});
    expect(agentDropTarget({cardId:'c1',areaId:null,canStart:false})).toEqual({kind:'card',channelId:'c1'});
  });
  it('targets empty canvas, with the area under the pointer or none',()=>{
    expect(agentDropTarget({cardId:null,areaId:'a1',canStart:true})).toEqual({kind:'canvas',areaId:'a1'});
    expect(agentDropTarget({cardId:undefined,areaId:null,canStart:true})).toEqual({kind:'canvas',areaId:null});
  });
  it('takes no empty-canvas drop without a handler',()=>{
    expect(agentDropTarget({cardId:null,areaId:'a1',canStart:false})).toBeNull();
    expect(agentDropTarget({cardId:null,areaId:null,canStart:false})).toBeNull();
  });
});

describe('newChatMembers',()=>{
  it('makes the dropped agent the only member',()=>{
    expect(newChatMembers('Moss','Pip')).toEqual([{subscriberType:'AGENT',subscriberId:'Moss'}]);
  });
  it('falls back to the personal agent',()=>{
    expect(newChatMembers(undefined,'Pip')).toEqual([{subscriberType:'AGENT',subscriberId:'Pip'}]);
  });
  it('is empty with neither',()=>{ expect(newChatMembers(undefined,undefined)).toEqual([]); });
});

describe('startSpot',()=>{
  it('centres the card on the drop point',()=>{
    expect(startSpot({x:1000,y:1000},[])).toEqual({x:1000-DEFAULT_CARD_WIDTH/2,y:1000-CARD_PLACE_HEIGHT/2});
  });
  it('moves down below a card it would cover',()=>{
    const other={x:900,y:900,w:DEFAULT_CARD_WIDTH,h:200};
    expect(startSpot({x:1000,y:1000},[other])).toEqual({x:1000-DEFAULT_CARD_WIDTH/2,y:other.y+other.h+PLACE_GAP});
  });
});

describe('startFailed',()=>{
  it('names the agent',()=>{ expect(startFailed('Moss')).toBe('Could not start a chat with Moss. Try again.'); });
  it('keeps the generic copy without one',()=>{ expect(startFailed()).toBe('Could not start a new chat. Try again.'); });
});
