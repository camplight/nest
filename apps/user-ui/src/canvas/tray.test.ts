import {describe,expect,it} from 'vitest';
import type {BoardCard,CanvasArea} from '@nest/schemas';
import type {Agent} from '../types';
import {TRAY_MAX,areaAgentNames,pickerAgents,trayAgents} from './tray';

const me='h1';
const agent=(name:string,ownerHumanId='h2'):Agent=>({name,ownerHumanId,visibility:'PUBLIC'});
const open=(channelId:string,x:number,agents:string[]):BoardCard=>({
  canvasId:'c1',channelId,x,y:100,w:280,version:0,placedBy:me,placedAt:1,access:'open',title:channelId,projectId:null,
  participants:agents.map(subscriberId=>({subscriberType:'AGENT',subscriberId})),archived:false,canManage:true,
});
const area=(id:string,x:number,w:number):CanvasArea=>({id,canvasId:'c1',title:id,x,y:0,w,h:400,tint:'moss',version:0});

describe('trayAgents',()=>{
  const roster=[agent('Zed',me),agent('Moss'),agent('Pip'),agent('Ash',me),agent('Kit',me)];
  const areas=[area('review',0,1000),area('later',2000,600)];
  const cards=[open('a',40,['Pip','Kit']),open('b',400,['Moss','Pip']),open('far',2100,['Ash'])];

  it('without a selection lists the person\'s own agents by name, then the team\'s',()=>{
    expect(trayAgents({agents:roster,humanId:me,cards,areas,selectedId:null}).map(a=>a.name)).toEqual(['Ash','Kit','Zed','Moss','Pip']);
  });

  it('puts the selected card\'s area suggestions first and leaves out agents already in it',()=>{
    // Card a has Pip and Kit; card b in the same area brings Moss. Ash (another area) and Zed are the person's own.
    const list=trayAgents({agents:roster,humanId:me,cards,areas,selectedId:'a'});
    expect(list.map(a=>[a.name,a.suggested])).toEqual([['Moss',true],['Ash',false],['Zed',false]]);
  });

  it('caps the tray at 8 faces and skips names not on the roster',()=>{
    const many=Array.from({length:30},(_,n)=>agent(`Helper ${String(n).padStart(2,'0')}`,me));
    const withGhost=[open('a',40,[]),open('b',400,['Nobody'])];
    const list=trayAgents({agents:many,humanId:me,cards:withGhost,areas,selectedId:'a'});
    expect(TRAY_MAX).toBe(8);
    expect(list).toHaveLength(8);
    expect(list.map(a=>a.name)).not.toContain('Nobody');
  });
});

describe('pickerAgents',()=>{
  const roster=[agent('Helper 01',me),agent('Pip'),agent('Moss',me),agent('Kit')];

  it('lists everyone by name, filters by owner, and ranks a search like mentions',()=>{
    expect(pickerAgents({agents:roster,humanId:me,query:'',owner:'all',inArea:null}).map(a=>a.name)).toEqual(['Helper 01','Kit','Moss','Pip']);
    expect(pickerAgents({agents:roster,humanId:me,query:'',owner:'yours',inArea:null}).map(a=>a.name)).toEqual(['Helper 01','Moss']);
    expect(pickerAgents({agents:roster,humanId:me,query:'',owner:'team',inArea:null}).map(a=>a.name)).toEqual(['Kit','Pip']);
    expect(pickerAgents({agents:roster,humanId:me,query:'pi',owner:'all',inArea:null}).map(a=>a.name)).toEqual(['Pip']);
  });

  it('limits to the agents present in an area\'s cards, nested areas included',()=>{
    const areas=[area('outer',0,1200),{...area('inner',600,500),y:20,h:300}];
    const cards=[open('a',40,['Pip']),open('nested',700,['Kit']),open('out',3000,['Moss'])];
    const names=areaAgentNames('outer',cards,areas);
    expect([...names].sort()).toEqual(['Kit','Pip']);
    expect(pickerAgents({agents:roster,humanId:me,query:'',owner:'all',inArea:names}).map(a=>a.name)).toEqual(['Kit','Pip']);
  });
});
