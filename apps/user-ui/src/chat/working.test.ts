import {describe,it,expect} from 'vitest';
import {activeTurns} from './working';
import type {EventRow} from '../types';
const ev=(id:string,type:string,source:string,createdAt:number,payload:Record<string,unknown>):EventRow=>({id,type,source,createdAt,channelId:'c1',payload});
const start=(id:string,agent:string,trigger:string,at:number)=>ev(id,'agent.turn.started',`agent:${agent}`,at,{triggerEventId:trigger});
const wrapper=(id:string,type:string,agent:string,trigger:string,at:number)=>ev(id,type,'system:runner:wrapper',at,{targetAgentName:agent,triggerEventId:trigger});
const phase=(id:string,agent:string,trigger:string,at:number,phaseName:string,text:string)=>ev(id,'agent.turn.phase',`agent:${agent}`,at,{triggerEventId:trigger,phase:phaseName,text});

describe('activeTurns',()=>{
 it('marks pre-restart work interrupted without guessing from age or availability',()=>{
  const begun=[start('s1','Pip','m1',1000)];
  expect(activeTurns(begun,[{name:'Pip',desiredState:'RUNNING',updatedAt:999999}],{Pip:2000})).toEqual([{agent:'Pip',triggerEventId:'m1',since:1000,interrupted:true}]);
  expect(activeTurns(begun,[{name:'Pip',lastStartedAt:2000}])).toEqual([{agent:'Pip',triggerEventId:'m1',since:1000,interrupted:true}]);
  expect(activeTurns(begun,[],{Pip:1000,Rex:2000})).toEqual([{agent:'Pip',triggerEventId:'m1',since:1000}]);
  expect(activeTurns([...begun,phase('p1','Pip','m1',3000,'wrapped-progress','Late progress')],[],{Pip:2000})[0]).not.toHaveProperty('progressText');
  expect(activeTurns([...begun,ev('done','agent.turn.completed','agent:Pip',3000,{triggerEventId:'m1'})],[],{Pip:2000})).toEqual([]);
  expect(activeTurns([...begun,start('s2','Pip','m2',3000)],[],{Pip:2000})).toEqual([{agent:'Pip',triggerEventId:'m2',since:3000}]);
  expect(activeTurns([...begun,start('retry','Pip','m1',3000)],[],{Pip:2000})).toEqual([{agent:'Pip',triggerEventId:'m1',since:3000}]);
  expect(activeTurns([...begun,ev('done','agent.turn.completed','agent:Pip',1500,{triggerEventId:'m1'}),start('retry','Pip','m1',3000)],[],{Pip:2000})).toEqual([{agent:'Pip',triggerEventId:'m1',since:3000}]);
 });
 it('start makes a turn',()=>{
  expect(activeTurns([start('s1','Pip','m1',1000)],[])).toStrictEqual([{agent:'Pip',triggerEventId:'m1',since:1000}]);
 });
 it('wrapper events attribute by targetAgentName',()=>{
  expect(activeTurns([wrapper('w1','wrapper.turn.started','Pip','m1',1000)],[])).toStrictEqual([{agent:'Pip',triggerEventId:'m1',since:1000}]);
  expect(activeTurns([wrapper('w1','wrapper.turn.started','Pip','m1',1000),start('s1','Pip','m1',1100)],[])).toStrictEqual([{agent:'Pip',triggerEventId:'m1',since:1000}]);
 });
 it('progress without a loaded start makes a turn',()=>{
  expect(activeTurns([phase('p1','Pip','m1',1500,'wrapped-progress','Product checks passed.')],[])).toStrictEqual([{agent:'Pip',triggerEventId:'m1',since:1500,progressText:'Product checks passed.',progressEventId:'p1'}]);
 });
 it('latest progress wins',()=>{
  const events=[start('s1','Pip','m1',1000),phase('p2','Pip','m1',1200,'wrapped-progress','Second.'),phase('p1','Pip','m1',1100,'wrapped-progress','First.')];
  expect(activeTurns(events,[])).toStrictEqual([{agent:'Pip',triggerEventId:'m1',since:1000,progressText:'Second.',progressEventId:'p2'}]);
 });
 it('codex-progress works the same',()=>{
  const events=[start('s1','Pip','m1',1000),phase('p1','Pip','m1',1100,'codex-progress','Running tests.')];
  expect(activeTurns(events,[])).toStrictEqual([{agent:'Pip',triggerEventId:'m1',since:1000,progressText:'Running tests.',progressEventId:'p1'}]);
 });
 it('other phases and whitespace-only text are ignored',()=>{
  const ignored=[phase('p1','Pip','m1',1100,'thinking','Private thought.'),phase('p2','Pip','m1',1200,'wrapped-progress','   \n\t ')];
  expect(activeTurns(ignored,[])).toStrictEqual([]);
  expect(activeTurns([start('s1','Pip','m1',1000),phase('p0','Pip','m1',1050,'wrapped-progress','Kept.'),...ignored],[])).toStrictEqual([{agent:'Pip',triggerEventId:'m1',since:1000,progressText:'Kept.',progressEventId:'p0'}]);
 });
 it('endings',()=>{
  const begun=[start('s1','Pip','m1',1000),phase('p1','Pip','m1',1100,'wrapped-progress','Working.')];
  expect(activeTurns(begun,[])).toHaveLength(1);
  const endings=[
   ev('e1','agent.turn.completed','agent:Pip',1200,{triggerEventId:'m1'}),
   ev('e1','agent.turn.failed','agent:Pip',1200,{triggerEventId:'m1'}),
   wrapper('e1','wrapper.turn.completed','Pip','m1',1200),
   wrapper('e1','wrapper.turn.failed','Pip','m1',1200),
  ];
  for(const end of endings){
   expect(activeTurns([...begun,end],[]),end.type).toStrictEqual([]);
   expect(activeTurns([...begun,end,phase('p2','Pip','m1',1300,'wrapped-progress','Late.')],[]),`${end.type} then progress`).toStrictEqual([]);
  }
 });
 it('superseded',()=>{
  const events=[start('s1','Pip','m1',1000),phase('p1','Pip','m1',1100,'wrapped-progress','Old work.'),start('s2','Pip','m2',2000)];
  const turns=activeTurns(events,[]);
  expect(turns).toStrictEqual([{agent:'Pip',triggerEventId:'m2',since:2000}]);
  expect(turns.some(turn=>turn.triggerEventId==='m1')).toBe(false);
 });
 it('stop requested after the turn began',()=>{
  const events=[start('s1','Pip','m1',1000)];
  const turn={agent:'Pip',triggerEventId:'m1',since:1000};
  expect(activeTurns(events,[{name:'Pip',desiredState:'STOPPED',updatedAt:2000}])).toStrictEqual([]);
  // Stopped before the turn began: the stop does not apply to this turn.
  expect(activeTurns(events,[{name:'Pip',desiredState:'STOPPED',updatedAt:500}])).toStrictEqual([turn]);
  expect(activeTurns(events,[{name:'Pip',desiredState:'RUNNING',updatedAt:2000}])).toStrictEqual([turn]);
  expect(activeTurns(events,[{name:'Pip',updatedAt:2000}])).toStrictEqual([turn]);
  expect(activeTurns(events,[])).toStrictEqual([turn]);
 });
 it('ordering',()=>{
  const events=[start('s2','Rex','m1',1500),start('s1','Pip','m1',1000)];
  expect(activeTurns(events,[])).toStrictEqual([{agent:'Pip',triggerEventId:'m1',since:1000},{agent:'Rex',triggerEventId:'m1',since:1500}]);
 });
 it('reads only allowed fields',()=>{
  const leaky=ev('p1','agent.turn.phase','agent:Pip',1100,{triggerEventId:'m1',phase:'wrapped-progress',text:'Product checks passed.',stderr:'SECRET',args:{token:'SECRET'}});
  const turns=activeTurns([{...start('s1','Pip','m1',1000),payload:{triggerEventId:'m1',stderr:'SECRET',args:{token:'SECRET'}}},leaky],[]);
  expect(turns).toStrictEqual([{agent:'Pip',triggerEventId:'m1',since:1000,progressText:'Product checks passed.',progressEventId:'p1'}]);
  expect(JSON.stringify(turns)).not.toContain('SECRET');
 });
});
