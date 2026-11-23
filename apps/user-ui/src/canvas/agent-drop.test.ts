import {describe,expect,it} from 'vitest';
import {DEFAULT_CARD_WIDTH} from '@nest/schemas';
import {CARD_PLACE_HEIGHT,PLACE_GAP} from './loose';
import {agentDragPlan,agentDropTarget,newChatMembers,startFailed,startSpot} from './agent-drop';

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

describe('agentDragPlan',()=>{
  const open={channelId:'c1',title:'Launch',access:'open',manageable:true,members:['Pip']};
  const base={agent:'Moss',canEdit:true,starts:true,invites:true};
  it('keeps today\'s path over a card',()=>{
    expect(agentDragPlan({...base,cardId:'c1',card:open})).toEqual({dropEffect:'copy',label:'Invite Moss to "Launch"',card:'c1',area:null,drop:{kind:'invite',channelId:'c1'}});
    // A locked card shows why, takes no drop and starts nothing, even for an editor with the start handler.
    expect(agentDragPlan({...base,cardId:'c2',card:{...open,channelId:'c2',access:'locked'}})).toEqual({dropEffect:null,label:"You can't add agents to this chat",card:null,area:null,drop:null});
    // A card missing from the board takes nothing.
    expect(agentDragPlan({...base,cardId:'gone',card:null})).toEqual({dropEffect:null,label:null,card:null,area:null,drop:null});
  });
  it('starts a chat on empty canvas for editors with the handler, in the area under the pointer or none',()=>{
    expect(agentDragPlan({...base,areaId:'a1',areaTitle:'Research'})).toEqual({dropEffect:'copy',label:'Start a chat with Moss in Research',card:null,area:'a1',drop:{kind:'start',areaId:'a1'}});
    expect(agentDragPlan({...base})).toEqual({dropEffect:'copy',label:'Start a chat with Moss',card:null,area:null,drop:{kind:'start',areaId:null}});
    // The drag's name is unknown until the drop (another window's drag): no label, the drop still starts.
    expect(agentDragPlan({...base,agent:null}).label).toBeNull();
    expect(agentDragPlan({...base,agent:null}).drop).toEqual({kind:'start',areaId:null});
  });
  it('takes nothing on empty canvas without the handler or for a viewer',()=>{
    const none={dropEffect:null,label:null,card:null,area:null,drop:null};
    expect(agentDragPlan({...base,starts:false,areaId:'a1',areaTitle:'Research'})).toEqual(none);
    expect(agentDragPlan({...base,canEdit:false})).toEqual(none);
  });
  it('invites only with the invite handler',()=>{
    expect(agentDragPlan({...base,invites:false,cardId:'c1',card:open})).toEqual({dropEffect:null,label:null,card:null,area:null,drop:null});
  });
});
