import {describe,expect,it} from 'vitest';
import {RING_MAX_STATIONS,ringState} from './ring';
import type {EventRow} from '../types';

let n=0;
const ev=(type:string,payload:Record<string,unknown>,at:number,source='agent:Pip'):EventRow=>({id:`e${++n}`,type,source,payload,createdAt:at});
const runner=(type:string,payload:Record<string,unknown>,at:number)=>ev(type,{ownerAgentName:'Pip',...payload},at,'system:process-runner');
const action=(app:string,title:string,change:string,outcome:string,at:number,agentName='Pip')=>
 ev('telemetry.nest.connection.action',{agentName,connectionId:'c',app,tool:'T',title,change,outcome,requestId:`r${at}`},at,'system:nest-connections');
const texts=(state:ReturnType<typeof ringState>)=>state.feed.map(entry=>entry.text);

describe('ringState',()=>{
 it('counts a shell command once although the engine records tool and process events',()=>{
  const state=ringState([
   ev('tool.started',{tool:'shell_run',args:{cmd:'ls'}},1),runner('process.started',{processId:'p'},2),
   runner('process.output',{stream:'STDOUT',text:'x'},3),runner('process.exited',{exitCode:0},4),ev('tool.executed',{tool:'shell_run',output:'x'},5),
  ],'Pip',0);
  expect(state.stations).toEqual([{key:'shell',label:'Shell',count:1,failed:false}]);
  expect(state.actions).toBe(1);
  expect(texts(state)).toEqual(['Shell · ran a command']);
 });
 it('shows an app read and a failed change on the app station',()=>{
  const state=ringState([action('miro','Get board','read','ok',1),action('miro','Create card','create','failed',2)],'Pip',0);
  expect(state.stations).toEqual([{key:'app:miro',label:'Miro',app:'miro',count:2,failed:true}]);
  expect(texts(state)).toEqual(['Miro · Create card','Miro · Get board']);
  expect(state.feed.map(entry=>entry.failed)).toEqual([true,false]);
 });
 it("keeps each agent's actions apart",()=>{
  const state=ringState([
   ev('tool.started',{tool:'fs_read'},1,'agent:Ann'),ev('tool.started',{tool:'shell_run'},2,'agent:Bob'),
   action('miro','Get board','read','ok',3,'Bob'),ev('tool.executed',{tool:'fs_read'},4,'agent:Ann'),
  ],'Ann',0);
  expect(state.stations.map(station=>station.key)).toEqual(['files']);
  expect(texts(state)).toEqual(['Files · read a file']);
 });
 it('ignores events from before the turn',()=>{
  const state=ringState([ev('tool.started',{tool:'shell_run'},9),ev('tool.executed',{tool:'shell_run'},9)],'Pip',10);
  expect(state.actions).toBe(0);
  expect(state.stations).toEqual([]);
 });
 it('marks a failing command',()=>{
  const state=ringState([ev('tool.started',{tool:'shell_run'},1),runner('process.exited',{exitCode:2},2),ev('tool.executed',{tool:'shell_run'},3)],'Pip',0);
  expect(state.stations[0]).toMatchObject({key:'shell',failed:true,count:1});
  expect(state.feed.map(entry=>[entry.text,entry.failed])).toEqual([['Shell · a command stopped with an error',true]]);
 });
 it('lists a background command that fails after its tool returned',()=>{
  const state=ringState([ev('tool.started',{tool:'shell_start'},1),ev('tool.executed',{tool:'shell_start'},2),runner('process.exited',{exitCode:1},3)],'Pip',0);
  expect(state.feed.map(entry=>[entry.text,entry.failed])).toEqual([['Shell · a command stopped with an error',true],['Shell · started a background command',false]]);
 });
 it('marks a failed tool',()=>{
  const state=ringState([ev('tool.started',{tool:'fs_write'},1),ev('tool.failed',{tool:'fs_write',error:'secret-error'},2)],'Pip',0);
  expect(state.stations[0]).toMatchObject({key:'files',failed:true});
  expect(state.feed[0]).toMatchObject({text:'Files · wrote a file',failed:true});
 });
 it('thinks between actions',()=>{
  const started=[ev('tool.started',{tool:'shell_run'},1)];
  expect(ringState(started,'Pip',0).thinking).toBe(false);
  expect(ringState([...started,ev('tool.executed',{tool:'shell_run'},2)],'Pip',0).thinking).toBe(true);
 });
 it('folds extra stations into Other',()=>{
  const apps=['a','b','c','d','e','f','g','h','i','j'];
  const state=ringState(apps.map((app,index)=>action(app,'Get thing','read','ok',index+1)),'Pip',0);
  expect(state.stations).toHaveLength(RING_MAX_STATIONS);
  expect(state.stations.at(-1)?.key).toBe('other');
  expect(state.stations.reduce((sum,station)=>sum+station.count,0)).toBe(10);
 });
 it('never puts arguments or output in the feed',()=>{
  const state=ringState([
   ev('tool.started',{tool:'fs_read',args:{path:'/secret/x'}},1),ev('tool.executed',{tool:'fs_read',args:{path:'/secret/x'},output:'secret'},2),
   ev('tool.started',{tool:'custom_tool',args:{q:'secret'}},3),ev('tool.failed',{tool:'custom_tool',error:'secret'},4),
  ],'Pip',0);
  expect(JSON.stringify(state)).not.toMatch(/secret/);
  expect(texts(state)).toEqual(['Other · used a tool','Files · read a file']);
 });
 it('keeps the last five actions',()=>{
  const state=ringState(Array.from({length:7},(_,index)=>action('miro',`Step ${index}`,'read','ok',index+1)),'Pip',0);
  expect(texts(state)).toEqual(['Miro · Step 6','Miro · Step 5','Miro · Step 4','Miro · Step 3','Miro · Step 2']);
  expect(state.actions).toBe(7);
 });
});
