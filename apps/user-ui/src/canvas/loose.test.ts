import {describe,expect,it} from 'vitest';
import type {Project} from '@nest/schemas';
import type {Channel} from '../types';
import type {AgentPulse,CardPulse} from './pulse';
import type {NeedsItem} from './needs';
import {CARD_PLACE_HEIGHT,GRID_STEP,PLACE_GAP,areaAround,clearOfCards,dayGroup,drawerLayout,dropPlacement,filterLoose,gridPlacement,looseChats,looseCounts,looseStatus,slotInArea,slotOutsideAreas,type LooseChat,type LooseFilter} from './loose';

const NOW=Date.UTC(2026,10,8,12);
const HOUR=3_600_000,DAY=24*HOUR;
const me='demo-owner',myId='human-1';
const chat=(id:string,patch:Partial<Channel>={}):Channel=>({id,name:`chat-${id}`,visibility:'PRIVATE',ownerHumanId:null,archivedAt:null,
  participants:[{subscriberType:'HUMAN',subscriberId:me},{subscriberType:'AGENT',subscriberId:'Pip'}],...patch});
const pulse=(lastActivityAt:number|null,needs=0):CardPulse=>({agents:[],people:[],lastActivityAt,artifacts:[],needsYou:Array.from({length:needs},(_,i)=>({kind:'mention' as const,id:`m${i}`,at:NOW,sender:'x',text:'hi'})),apps:{apps:[],reads:0,changes:0}});
const project=(id:string,channelId:string,name:string):Project=>({id,ownerId:myId,channelId,name,description:'',createdAt:NOW-10*DAY});
const base={projects:[] as Project[],boardChannelIds:new Set<string>(),hidden:new Set<string>(),username:me,userId:myId,pulses:new Map<string,CardPulse>(),showHidden:false};
const ANY:LooseFilter={query:'',state:'all',agent:null};

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

const looseItem=(channelId:string,patch:Partial<LooseChat>):LooseChat=>({channelId,projectId:null,title:`Chat ${channelId}`,participants:[],lastActivityAt:null,
  needsYou:false,agents:[],state:'done',reason:null,line:'',...patch});

describe('filterLoose',()=>{
  const items:LooseChat[]=[
    looseItem('1',{title:'Invoice run',agents:['Pip'],needsYou:true,state:'need',reason:'approve refund'}),
    looseItem('2',{title:'Launch plan',agents:['Moss'],state:'working'}),
    looseItem('3',{title:'Old notes',participants:[{subscriberType:'HUMAN',subscriberId:'invoice-team'}]}),
    looseItem('4',{title:'Silent',agents:['Invoicer']}),
  ];
  const ids=(filter:Partial<LooseFilter>)=>filterLoose(items,{...ANY,...filter}).map(c=>c.channelId);

  it('matches the query case-insensitively against the title and agent names, not people',()=>{
    expect(ids({query:'INVOICE'})).toEqual(['1','4']);
    expect(ids({query:'moss'})).toEqual(['2']);
    expect(ids({query:'  '})).toEqual(['1','2','3','4']);
  });
  it('filters by state chip and agent',()=>{
    expect(ids({state:'need'})).toEqual(['1']);
    expect(ids({state:'working'})).toEqual(['2']);
    expect(ids({state:'done'})).toEqual(['3','4']);
    expect(ids({agent:'Moss'})).toEqual(['2']);
    expect(ids({agent:'Moss',state:'done'})).toEqual([]);
  });
  it('counts every chat and each state for the chips',()=>{
    expect(looseCounts(items)).toEqual({all:4,need:1,working:1,done:2});
  });

  it('filters 250 chats in under 10 ms',()=>{
    const many:LooseChat[]=Array.from({length:250},(_,i)=>looseItem(`c${i}`,{projectId:`p${i}`,title:i%7?`Synthetic chat ${i}`:`Invoice batch ${i}`,
      participants:[{subscriberType:'HUMAN',subscriberId:me},{subscriberType:'AGENT',subscriberId:`Agent${i%9}`}],lastActivityAt:NOW-i*HOUR,
      state:i%5===0?'need':i%3===0?'working':'done',agents:[`Agent${i%9}`]}));
    filterLoose(many,{...ANY,query:'warm'}); // warm the JIT
    const start=performance.now();
    const result=filterLoose(many,{query:'invoice',state:'done',agent:'Agent4'});
    const elapsed=performance.now()-start;
    expect(result.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(10);
  });
});

describe('looseStatus',()=>{
  const agent=(name:string,state:AgentPulse['state'],extra:Partial<AgentPulse>={}):AgentPulse=>({name,state,since:NOW-HOUR,...extra});
  const live=(agents:AgentPulse[],people:CardPulse['people']=[]):CardPulse=>({...pulse(NOW-HOUR),agents,people});
  const review:NeedsItem={key:'review:t1',kind:'review',channelId:'c1',chatTitle:'Refunds',detail:'',at:NOW,from:'Pip',short:'Review Approve refund',reason:'Approve refund'};
  const mention:NeedsItem={key:'mention:m1',kind:'mention',channelId:'c1',chatTitle:'Refunds',detail:'',at:NOW-HOUR,from:'sarah',short:'sarah: Can you check?',reason:'Can you check?'};

  it('needs you with the newest Needs you item\'s reason, even while an agent works',()=>{
    expect(looseStatus(['Pip'],live([agent('Pip','working',{activity:'Drafting'})]),[review,mention])).toEqual({state:'need',reason:'Approve refund',line:'Pip · Drafting'});
  });
  it('without the Needs you items, an unread mention\'s first line is the reason',()=>{
    expect(looseStatus(['Pip'],{...pulse(NOW),needsYou:[{kind:'mention',id:'m',at:NOW,sender:'sarah',text:'**Check** this\nplease'}]},undefined).reason).toBe('Check this');
    expect(looseStatus(['Pip'],pulse(NOW),[]).reason).toBeNull();
  });
  it('is working when any agent is in a live turn (working or quiet), else done',()=>{
    expect(looseStatus(['Pip','Moss'],live([agent('Pip','idle'),agent('Moss','working')]),[]).state).toBe('working');
    expect(looseStatus(['Pip'],live([agent('Pip','quiet',{quietMinutes:30})]),[]).state).toBe('working');
    expect(looseStatus(['Pip'],live([agent('Pip','done')]),[]).state).toBe('done');
    expect(looseStatus(['Pip'],undefined,[]).state).toBe('done');
  });
  it('says what the first agent is doing, as its card row does',()=>{
    expect(looseStatus(['Pip','Moss'],live([agent('Pip','working',{app:{app:'gmail',appName:'Gmail',action:'Fetch emails'}}),agent('Moss','working',{activity:'x'})]),[]).line).toBe('Pip · Gmail · Fetch emails');
    expect(looseStatus(['Pip'],live([agent('Pip','done',{said:'Sent the draft'})]),[]).line).toBe('Pip · Sent the draft');
    expect(looseStatus(['Pip'],live([agent('Pip','failed')]),[]).line).toBe('Pip · ran into an error');
  });
  it('falls back to the newest message a person posted, then to nothing',()=>{
    const people=[{name:'sarah',at:NOW-2*HOUR,said:'Older',files:0},{name:'lena',at:NOW-HOUR,said:'Newest note',files:0}];
    expect(looseStatus(['Pip'],live([agent('Pip','idle')],people),[]).line).toBe('Newest note');
    expect(looseStatus([],live([],people),[]).line).toBe('Newest note');
    expect(looseStatus(['Pip'],live([agent('Pip','idle')]),[]).line).toBe('');
  });
  it('looseChats uses the chat\'s Needs you items when given, reviews included',()=>{
    const [item]=looseChats({...base,channels:[chat('c1')],needs:new Map([['c1',[review]]])});
    expect(item).toMatchObject({needsYou:true,state:'need',reason:'Approve refund'});
    const [quiet]=looseChats({...base,channels:[chat('c1')],pulses:new Map([['c1',pulse(NOW,1)]]),needs:new Map()});
    expect(quiet).toMatchObject({needsYou:false,state:'done',reason:null});
  });
});

describe('day groups',()=>{
  // Local calendar times: noon on Wednesday 11 November 2026.
  const now=new Date(2026,10,11,12).getTime();
  const at=(day:number,hour=0,minute=0)=>new Date(2026,10,day,hour,minute).getTime();
  it('splits by the local calendar day: today, yesterday, this week, older',()=>{
    expect(dayGroup(at(11,0,0),now)).toBe('Today');
    expect(dayGroup(at(10,23,59),now)).toBe('Yesterday');
    expect(dayGroup(at(10,0,0),now)).toBe('Yesterday');
    expect(dayGroup(at(9,23),now)).toBe('This week');
    expect(dayGroup(at(5,0),now)).toBe('This week');
    expect(dayGroup(at(4,23),now)).toBe('Older');
    expect(dayGroup(null,now)).toBe('Older');
  });
  it('lays out headers and rows in order and folds Older until shown',()=>{
    const items=[looseItem('a',{lastActivityAt:at(11,9)}),looseItem('b',{lastActivityAt:at(11,8)}),looseItem('c',{lastActivityAt:at(8)}),looseItem('d',{lastActivityAt:null})];
    const folded=drawerLayout(items,now,true,false);
    expect(folded.items.map(i=>i.kind==='group'?`${i.name} · ${i.count}${i.fold?` ${i.fold}`:''}`:i.chat.channelId)).toEqual(['Today · 2','a','b','This week · 1','c','Older · 1 show']);
    expect(folded.rows.map(c=>c.channelId)).toEqual(['a','b','c']);
    expect(folded.items.map(i=>i.top)).toEqual([0,30,78,126,156,204]);
    expect(folded.height).toBe(234);
    const shown=drawerLayout(items,now,true,true);
    expect(shown.items.at(-2)).toMatchObject({kind:'group',name:'Older',fold:'hide'});
    expect(shown.items.at(-1)).toMatchObject({kind:'row',index:3});
    // A search or a chip never folds Older.
    expect(drawerLayout(items,now,false,false).items.at(-1)).toMatchObject({kind:'row',index:3});
    expect(drawerLayout([],now,true,false)).toEqual({items:[],rows:[],height:0});
  });
});

describe('gridPlacement',()=>{
  it('lays cards out 3 across, 300×300 apart, centred on the point, with a 48 px area around them',()=>{
    const {cards,bounds}=gridPlacement(['a','b','c','d'],{x:1000,y:500});
    // 3 columns × 2 rows: (2×300+280) × (1×300+260) = 880 × 560, centred on (1000,500).
    expect(bounds).toEqual({x:560,y:220,w:880,h:560});
    expect(cards).toEqual([
      {channelId:'a',x:560,y:220},{channelId:'b',x:860,y:220},{channelId:'c',x:1160,y:220},
      {channelId:'d',x:560,y:520},
    ]);
    expect(areaAround(bounds)).toEqual({x:512,y:172,w:976,h:656});
    const one=gridPlacement(['a'],{x:0,y:0});
    expect(one.cards).toEqual([{channelId:'a',x:-140,y:-130}]);
  });
  it('keeps rows of cards as tall as the placement estimate apart, inside the grid and its area',()=>{
    const {cards,bounds}=gridPlacement(['a','b','c','d','e','f','g'],{x:0,y:0});
    const rects=cards.map(card=>({...card,w:280,h:CARD_PLACE_HEIGHT}));
    for(const [i,a] of rects.entries())for(const b of rects.slice(i+1)){
      const apart=a.x+a.w<=b.x||b.x+b.w<=a.x||a.y+a.h<=b.y||b.y+b.h<=a.y;
      expect(apart,`${a.channelId} and ${b.channelId} overlap`).toBe(true);
    }
    // Rows keep the mock's 40 px between a full-height card and the next row.
    expect(GRID_STEP.y-CARD_PLACE_HEIGHT).toBeGreaterThanOrEqual(PLACE_GAP);
    const area=areaAround(bounds);
    for(const r of rects){
      expect(r.x>=bounds.x&&r.y>=bounds.y&&r.x+r.w<=bounds.x+bounds.w&&r.y+r.h<=bounds.y+bounds.h).toBe(true);
      expect(r.y+r.h<=area.y+area.h-48).toBe(true);
    }
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
    // Two unmeasured cards under the grid; the lower one's bottom is 300 + the placement estimate.
    expect(clearOfCards(rect,[{x:100,y:0,w:280},{x:500,y:300,w:280}])).toBe(300+CARD_PLACE_HEIGHT+PLACE_GAP);
  });
  it('uses a mounted card\'s measured height',()=>{
    expect(clearOfCards(rect,[{x:100,y:0,w:280,h:180}])).toBe(180+PLACE_GAP);
  });
  it('keeps moving while the moved grid lands on a card further down',()=>{
    const below={x:0,y:200+PLACE_GAP+100,w:280};
    expect(clearOfCards(rect,[{x:0,y:40,w:280},below])).toBe(below.y+CARD_PLACE_HEIGHT+PLACE_GAP);
  });
  it('clears the area around the grid when there is one',()=>{
    const area=areaAround(rect);
    expect(clearOfCards(area,[{x:-40,y:-200,w:280}])).toBe(-200+CARD_PLACE_HEIGHT+PLACE_GAP-area.y);
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
    expect(slotInArea(area,[{x:132,y:172,w:280},{x:450,y:180,w:280}])).toEqual({x:132,y:472});
    // The moving card's measured height decides whether a spot clears the card below it.
    const below=[{x:132,y:172,w:280},{x:432,y:450,w:280}];
    expect(slotInArea(area,below)).toEqual({x:132,y:472});
    expect(slotInArea(area,below,280,180)).toEqual({x:432,y:172});
  });
  it('uses one column in a narrow area and goes below its last card when it is full',()=>{
    const narrow={x:0,y:0,w:344,h:300};
    expect(slotInArea(narrow,[{x:32,y:72,w:280}])).toEqual({x:32,y:372});
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
    expect(spot.y).toBeGreaterThanOrEqual(300+CARD_PLACE_HEIGHT+PLACE_GAP/2);
  });
});
