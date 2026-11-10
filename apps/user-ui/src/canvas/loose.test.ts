import {describe,expect,it} from 'vitest';
import type {Project} from '@nest/schemas';
import type {Channel} from '../types';
import type {CardPulse} from './pulse';
import {PLACE_GAP,areaAround,clearOfCards,dropPlacement,filterLoose,gridPlacement,looseChats,slotInArea,slotOutsideAreas,type LooseChat,type LooseFilter} from './loose';

const NOW=Date.UTC(2026,10,8,12);
const HOUR=3_600_000,DAY=24*HOUR;
const me='demo-owner',myId='human-1';
const chat=(id:string,patch:Partial<Channel>={}):Channel=>({id,name:`chat-${id}`,visibility:'PRIVATE',ownerHumanId:null,archivedAt:null,
  participants:[{subscriberType:'HUMAN',subscriberId:me},{subscriberType:'AGENT',subscriberId:'Pip'}],...patch});
const pulse=(lastActivityAt:number|null,needs=0):CardPulse=>({agents:[],lastActivityAt,artifacts:[],needsYou:Array.from({length:needs},(_,i)=>({kind:'mention' as const,id:`m${i}`,at:NOW,sender:'x',text:'hi'})),apps:{apps:[],reads:0,changes:0}});
const project=(id:string,channelId:string,name:string):Project=>({id,ownerId:myId,channelId,name,description:'',createdAt:NOW-10*DAY});
const base={projects:[] as Project[],boardChannelIds:new Set<string>(),hidden:new Set<string>(),username:me,userId:myId,pulses:new Map<string,CardPulse>(),showHidden:false};
const ANY:LooseFilter={query:'',needsYou:false,agent:null,age:'any'};

describe('looseChats',()=>{
  it('keeps chats the person is in or owns that are not on the board, not hidden and not archived',()=>{
    const channels=[
      chat('in'),
      chat('owned',{participants:[{subscriberType:'AGENT',subscriberId:'Pip'}],ownerHumanId:myId}),
      chat('placed'),
      chat('hidden'),
      chat('archived',{archivedAt:NOW-HOUR}),
      chat('stranger',{participants:[{subscriberType:'HUMAN',subscriberId:'someone-else'}],ownerHumanId:'human-2'}),
      // A public channel visible to everyone is not a chat the person is part of.
      chat('public',{visibility:'PUBLIC',participants:[]}),
      chat('lifecycle',{name:'agent.lifecycle.Pip'}),
      // An agent named like the person is not the person.
      chat('agent-namesake',{participants:[{subscriberType:'AGENT',subscriberId:me}]}),
    ];
    const ids=(showHidden:boolean)=>looseChats({...base,channels,boardChannelIds:new Set(['placed']),hidden:new Set(['hidden']),showHidden}).map(c=>c.channelId).sort();
    expect(ids(false)).toEqual(['in','owned']);
    expect(ids(true)).toEqual(['hidden','in','owned']);
  });

  it('titles a project chat by its project name and lists its agents, needs-you and activity',()=>{
    const [item]=looseChats({...base,channels:[chat('c1')],projects:[project('p1','c1','Invoice cleanup')],pulses:new Map([['c1',pulse(NOW-HOUR,2)]])});
    expect(item).toMatchObject({channelId:'c1',projectId:'p1',title:'Invoice cleanup',agents:['Pip'],needsYou:true,lastActivityAt:NOW-HOUR});
    const [plain]=looseChats({...base,channels:[chat('c2')]});
    expect(plain).toMatchObject({projectId:null,title:'chat-c2',needsYou:false,lastActivityAt:null});
  });

  it('sorts by lastActivityAt descending, then by title',()=>{
    const channels=[chat('a',{name:'Bravo'}),chat('b',{name:'Alpha'}),chat('c',{name:'Charlie'}),chat('d',{name:'Delta'})];
    const pulses=new Map([['c',pulse(NOW-DAY)],['d',pulse(NOW-HOUR)]]);
    expect(looseChats({...base,channels,pulses}).map(c=>c.title)).toEqual(['Delta','Charlie','Alpha','Bravo']);
  });
});

describe('filterLoose',()=>{
  const items:LooseChat[]=[
    {channelId:'1',projectId:null,title:'Invoice run',participants:[{subscriberType:'AGENT',subscriberId:'Pip'}],lastActivityAt:NOW-HOUR,needsYou:true,agents:['Pip']},
    {channelId:'2',projectId:null,title:'Launch plan',participants:[{subscriberType:'AGENT',subscriberId:'Moss'}],lastActivityAt:NOW-3*DAY,needsYou:false,agents:['Moss']},
    {channelId:'3',projectId:null,title:'Old notes',participants:[{subscriberType:'HUMAN',subscriberId:'invoice-team'}],lastActivityAt:NOW-30*DAY,needsYou:false,agents:[]},
    {channelId:'4',projectId:null,title:'Silent',participants:[],lastActivityAt:null,needsYou:false,agents:[]},
  ];
  const ids=(filter:Partial<LooseFilter>)=>filterLoose(items,{...ANY,...filter},NOW).map(c=>c.channelId);

  it('matches the query case-insensitively against the title and participant ids',()=>{
    expect(ids({query:'INVOICE'})).toEqual(['1','3']);
    expect(ids({query:'moss'})).toEqual(['2']);
    expect(ids({query:'  '})).toEqual(['1','2','3','4']);
  });
  it('filters by needs you and agent',()=>{
    expect(ids({needsYou:true})).toEqual(['1']);
    expect(ids({agent:'Moss'})).toEqual(['2']);
  });
  it('age today keeps only chats active in the last 24 h; week and older split the rest',()=>{
    expect(ids({age:'today'})).toEqual(['1']);
    expect(ids({age:'week'})).toEqual(['1','2']);
    expect(ids({age:'older'})).toEqual(['3','4']);
  });

  it('filters 250 chats in under 10 ms',()=>{
    const many:LooseChat[]=Array.from({length:250},(_,i)=>({channelId:`c${i}`,projectId:`p${i}`,title:i%7?`Synthetic chat ${i}`:`Invoice batch ${i}`,
      participants:[{subscriberType:'HUMAN',subscriberId:me},{subscriberType:'AGENT',subscriberId:`Agent${i%9}`}],lastActivityAt:NOW-i*HOUR,needsYou:i%5===0,agents:[`Agent${i%9}`]}));
    filterLoose(many,{...ANY,query:'warm'},NOW); // warm the JIT
    const start=performance.now();
    const result=filterLoose(many,{query:'invoice',needsYou:false,agent:'Agent3',age:'week'},NOW);
    const elapsed=performance.now()-start;
    expect(result.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(10);
  });
});

describe('gridPlacement',()=>{
  it('lays cards out 3 across, 300×200 apart, centred on the point, with a 48 px area around them',()=>{
    const {cards,bounds}=gridPlacement(['a','b','c','d'],{x:1000,y:500});
    // 3 columns × 2 rows: (2×300+280) × (1×200+160) = 880 × 360, centred on (1000,500).
    expect(bounds).toEqual({x:560,y:320,w:880,h:360});
    expect(cards).toEqual([
      {channelId:'a',x:560,y:320},{channelId:'b',x:860,y:320},{channelId:'c',x:1160,y:320},
      {channelId:'d',x:560,y:520},
    ]);
    expect(areaAround(bounds)).toEqual({x:512,y:272,w:976,h:456});
    const one=gridPlacement(['a'],{x:0,y:0});
    expect(one.cards).toEqual([{channelId:'a',x:-140,y:-80}]);
  });
});

describe('dropPlacement',()=>{
  it('centres a default-width card on the drop point',()=>{
    expect(dropPlacement({x:200,y:150})).toEqual({x:60,y:70});
    expect(dropPlacement({x:0,y:0},400)).toEqual({x:-200,y:-80});
  });
});

describe('clearOfCards',()=>{
  const rect={x:0,y:0,w:880,h:360};
  it('leaves a grid that covers no card where it is',()=>{
    expect(clearOfCards(rect,[])).toBe(0);
    expect(clearOfCards(rect,[{x:900,y:0,w:280},{x:0,y:360,w:280}])).toBe(0);
  });
  it('moves a grid below the lowest card it overlaps, plus a gap',()=>{
    // Two cards under the grid; the lower one's bottom is 300 + 160.
    expect(clearOfCards(rect,[{x:100,y:0,w:280},{x:500,y:300,w:280}])).toBe(460+PLACE_GAP);
  });
  it('keeps moving while the moved grid lands on a card further down',()=>{
    const below={x:0,y:200+PLACE_GAP+100,w:280};
    expect(clearOfCards(rect,[{x:0,y:40,w:280},below])).toBe(below.y+160+PLACE_GAP);
  });
  it('clears the area around the grid when there is one',()=>{
    const area=areaAround(rect);
    expect(clearOfCards(area,[{x:-40,y:-200,w:280}])).toBe(-200+160+PLACE_GAP-area.y);
  });
});

describe('a removed card',()=>{
  it('returns its chat to the loose chats unless the person hid it',()=>{
    const channels=[chat('a'),chat('b')];
    const ids=(board:string[],hidden:string[]=[])=>looseChats({...base,channels,boardChannelIds:new Set(board),hidden:new Set(hidden)}).map(c=>c.channelId).sort();
    expect(ids(['a','b'])).toEqual([]);
    expect(ids(['b'])).toEqual(['a']);
    expect(ids(['b'],['a'])).toEqual([]);
  });
});

describe('slotInArea',()=>{
  const area={x:100,y:100,w:700,h:400};
  it('takes the first spot under the title bar of an empty area',()=>{
    expect(slotInArea(area,[])).toEqual({x:132,y:172});
  });
  it('skips taken spots row by row, keeping a gap from every card',()=>{
    expect(slotInArea(area,[{x:132,y:172,w:280}])).toEqual({x:432,y:172});
    expect(slotInArea(area,[{x:132,y:172,w:280},{x:450,y:180,w:280}])).toEqual({x:132,y:372});
  });
  it('uses one column in a narrow area and goes below its last card when it is full',()=>{
    const narrow={x:0,y:0,w:344,h:300};
    expect(slotInArea(narrow,[{x:32,y:72,w:280}])).toEqual({x:32,y:272});
  });
});

describe('slotOutsideAreas',()=>{
  const home={x:0,y:0,w:400,h:300};
  it('goes just right of the area the card leaves',()=>{
    expect(slotOutsideAreas(home,[home],[])).toEqual({x:400+PLACE_GAP,y:0});
  });
  it('steps down past cards and other areas until the card sits in none',()=>{
    const neighbour={x:450,y:-50,w:400,h:300};
    const spot=slotOutsideAreas(home,[home,neighbour],[{x:440,y:300,w:280}]);
    expect(spot.x).toBe(440);
    expect(spot.y).toBeGreaterThanOrEqual(300+160+PLACE_GAP/2);
  });
});
