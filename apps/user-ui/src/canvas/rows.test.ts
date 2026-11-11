import {describe,expect,it} from 'vitest';
import type {CardPulse} from './pulse';
import type {NeedsItem} from './needs';
import {MAX_ROWS,participantRows,shownRows} from './rows';

const base:CardPulse={agents:[],people:[],lastActivityAt:null,artifacts:[],fileCount:0,needsYou:[],apps:{apps:[],reads:0,changes:0}};
const agent=(name:string)=>({subscriberType:'AGENT',subscriberId:name});
const human=(name:string)=>({subscriberType:'HUMAN',subscriberId:name});
const item=(kind:'mention'|'review',from:string|null,reason:string,at=1):NeedsItem=>{
  const short=kind==='review'?`Review ${reason}`:`${from}: ${reason}`;
  return {key:`${kind}:${short}`,kind,channelId:'c1',chatTitle:'Launch',detail:short,at,from,short,reason};
};
const rows=(pulse:Partial<CardPulse>,participants=[agent('Pip'),human('mate'),human('me')],needs:NeedsItem[]=[])=>participantRows({participants,pulse:{...base,...pulse},needs,viewer:'me'});

describe('participantRows',()=>{
  it('shows each agent\'s live activity: the app in use while working, else the progress line, else the state',()=>{
    const result=rows({agents:[
      {name:'Pip',state:'working',since:1,activity:'Drafting',app:{app:'gmail',appName:'Gmail',action:'Fetch emails'}},
      {name:'Pom',state:'working',since:1,activity:'Drafting the post'},
      {name:'Moss',state:'working',since:1},
      {name:'Muff',state:'quiet',since:1,quietMinutes:23,activity:'waiting for CI'},
    ]},[agent('Pip'),agent('Pom'),agent('Moss'),agent('Muff')]);
    expect(result.map(r=>[r.name,r.state,r.text])).toEqual([
      ['Pip','working','Gmail · Fetch emails'],['Pom','working','Drafting the post'],['Moss','working','working'],['Muff','quiet','quiet for 23 min · last: waiting for CI'],
    ]);
    expect(result[0].app).toEqual({app:'gmail',appName:'Gmail',action:'Fetch emails'});
    expect(result[1].app).toBeNull();
  });

  it('done and idle agents show their latest message line; problems say what happened',()=>{
    const result=rows({agents:[
      {name:'Pip',state:'done',since:1,said:'PR #812 open, tests green'},{name:'Pom',state:'done',since:1},{name:'Moss',state:'idle',since:0},
      {name:'Muff',state:'failed',since:1,said:'ignored'},{name:'Puff',state:'interrupted',since:1},{name:'Rook',state:'unavailable',since:1},
    ]},[]);
    expect(result.map(r=>r.text)).toEqual(['PR #812 open, tests green','done','idle','ran into an error','stopped unexpectedly','unavailable']);
  });

  it('lists people after agents with the viewer last as You, with what they last posted',()=>{
    const result=rows({agents:[{name:'Pip',state:'idle',since:0}],people:[{name:'me',at:2,said:'asked for a post',files:0},{name:'mate',at:1,said:'hi',files:2}]},[agent('Pip'),human('me'),human('mate'),human('quiet-one')]);
    expect(result.map(r=>[r.kind,r.label,r.state,r.text])).toEqual([
      ['agent','Pip','idle','idle'],['human','mate','posted','shared 2 files'],['human','quiet-one','idle',''],['human','You','posted','asked for a post'],
    ]);
  });

  it('waits on you only for a Needs you item from that participant: a review of the agent\'s task or a person\'s mention',()=>{
    const result=rows({agents:[{name:'Pip',state:'done',since:1,said:'draft ready'},{name:'Pom',state:'done',since:1}],people:[{name:'mate',at:1,said:'hi',files:0}]},
      [agent('Pip'),agent('Pom'),human('mate'),human('me')],
      [item('review','Pip','Review: Launch post',3),item('mention','mate','note: pick a hook',2),item('review',null,'Orphan task',1)]);
    // The reason is stored on the item, so a colon inside it is kept as written.
    expect(result.map(r=>[r.name,r.state,r.text])).toEqual([
      ['Pip','waiting','needs your review · Review: Launch post'],['Pom','done','done'],['mate','waiting','needs you · note: pick a hook'],['me','idle',''],
    ]);
  });

  it('a live turn or a problem outranks waiting, and a person never waits for an agent\'s review with the same name',()=>{
    const result=rows({agents:[{name:'Pip',state:'working',since:1},{name:'Pom',state:'failed',since:1}]},[agent('Pip'),agent('Pom'),human('Pip')],
      [item('review','Pip','A'),item('review','Pom','B')]);
    expect(result.map(r=>[r.kind,r.state])).toEqual([['agent','working'],['agent','failed'],['human','idle']]);
  });

  it('without a pulse yet, every agent is idle',()=>{
    expect(participantRows({participants:[agent('Pip')],needs:[],viewer:'me'}).map(r=>[r.name,r.state])).toEqual([['Pip','idle']]);
  });
});

describe('shownRows',()=>{
  it(`shows up to ${MAX_ROWS} rows, keeping the ones that most need a look in their usual order`,()=>{
    const all=rows({agents:['A','B','C','D','E'].map(name=>({name,state:name==='E'?'working' as const:'idle' as const,since:0}))},['A','B','C','D','E'].map(agent));
    const {shown,hidden}=shownRows(all);
    expect(shown.map(r=>r.name)).toEqual(['A','B','C','E']);
    expect(hidden).toBe(1);
    expect(shownRows(all.slice(0,4))).toEqual({shown:all.slice(0,4),hidden:0});
  });
});
