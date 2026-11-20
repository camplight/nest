import {describe,expect,it} from 'vitest';
import {RING_MAX_STATIONS,finishedText,finishedTurn,ringState,ringStatusText} from './ring';
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
 it('is thinking when no tool is running',()=>{
  expect(ringState([ev('tool.started',{tool:'fs_read'},1),ev('tool.executed',{tool:'fs_read'},2)],'Pip',0).status).toEqual({kind:'thinking'});
 });
 it('waits on a running command since it started',()=>{
  expect(ringState([ev('tool.started',{tool:'shell_run'},5),runner('process.started',{processId:'p'},6)],'Pip',0).status).toEqual({kind:'command',since:5});
 });
 it('names the app a running command is using',()=>{
  const state=ringState([ev('tool.started',{tool:'shell_run'},5),action('fathom','List Meetings','read','ok',6),action('miro','Get board','read','ok',7)],'Pip',0);
  expect(state.status).toEqual({kind:'app',label:'Miro'});
 });
 it('does not name an app used by an earlier command',()=>{
  const state=ringState([
   ev('tool.started',{tool:'shell_run'},1),action('miro','Get board','read','ok',2),ev('tool.executed',{tool:'shell_run'},3),
   ev('tool.started',{tool:'shell_run'},4),
  ],'Pip',0);
  expect(state.status).toEqual({kind:'command',since:4});
 });
 it('is working while another tool runs',()=>{
  expect(ringState([ev('tool.started',{tool:'fs_read'},1)],'Pip',0).status).toEqual({kind:'working'});
 });
 it('merges repeated actions in a row into one entry with a count',()=>{
  const state=ringState([
   action('fathom','List Meetings','read','ok',1),action('fathom','List Meetings','read','ok',2),action('fathom','List Meetings','read','ok',3),
   action('miro','Get board','read','ok',4),action('fathom','List Meetings','read','ok',5),
  ],'Pip',0);
  expect(state.feed.map(entry=>[entry.text,entry.count])).toEqual([['Fathom · List Meetings',1],['Miro · Get board',1],['Fathom · List Meetings',3]]);
  expect(state.feed[2]?.at).toBe(3);
  expect(state.actions).toBe(5);
 });
 it('keeps five distinct entries when many repeats come first',()=>{
  const repeats=Array.from({length:30},(_,index)=>action('fathom','List Meetings','read','ok',index+1));
  const state=ringState([...repeats,...['a','b','c','d'].map((step,index)=>action('miro',`Step ${step}`,'read','ok',40+index))],'Pip',0);
  expect(state.feed.map(entry=>entry.text).at(-1)).toBe('Fathom · List Meetings');
  expect(state.feed.at(-1)?.count).toBe(30);
 });
 it('never merges a failure into successes',()=>{
  const state=ringState([action('miro','Create card','create','ok',1),action('miro','Create card','create','failed',2)],'Pip',0);
  expect(state.feed.map(entry=>[entry.failed,entry.count])).toEqual([[true,1],[false,1]]);
 });
 it('shows an app call made through the connections command on its app station, not Shell',()=>{
  const state=ringState([
   ev('tool.started',{tool:'shell_run',args:{cmd:'node connections.mjs execute conn-1 TRELLO_GET_BOARDS --input {}'}},1),
   ev('tool.executed',{tool:'shell_run',output:'secret-board'},2),
   ev('tool.started',{tool:'shell_run',args:{cmd:'ls'}},3),ev('tool.executed',{tool:'shell_run'},4),
   ev('tool.started',{tool:'shell_run',args:{command:'node connections.mjs execute conn-2 GOOGLESHEETS_BATCH_UPDATE'}},5),
   runner('process.exited',{exitCode:1},6),ev('tool.executed',{tool:'shell_run'},7),
  ],'Pip',0);
  expect(state.stations).toEqual([
   {key:'app:trello',label:'Trello',app:'trello',count:1,failed:false},
   {key:'shell',label:'Shell',count:1,failed:false},
   {key:'app:googlesheets',label:'Google Sheets',app:'googlesheets',count:1,failed:true},
  ]);
  expect(state.actions).toBe(3);
  expect(state.feed.map(entry=>[entry.station,entry.failed])).toEqual([['app:googlesheets',true],['shell',false],['app:trello',false]]);
  expect(state.feed[2]?.text).toMatch(/^Trello · /);
  expect(state.feed[0]?.text).toMatch(/^Google Sheets · /);
  expect(JSON.stringify(state)).not.toMatch(/conn-1|secret|--input/);
 });
 it('names the app a running connections command is using',()=>{
  const state=ringState([ev('tool.started',{tool:'shell_run',args:{cmd:'node connections.mjs execute c TRELLO_GET_BOARDS'}},5)],'Pip',0);
  expect(state.status).toEqual({kind:'app',label:'Trello'});
 });
 it('counts an app call once when the chat also has its action line',()=>{
  const state=ringState([
   ev('tool.started',{tool:'shell_run',args:{cmd:'node connections.mjs execute c MIRO_GET_BOARD'}},1),
   action('miro','Get board','read','ok',2),ev('tool.executed',{tool:'shell_run'},3),
  ],'Pip',0);
  expect(state.stations).toEqual([{key:'shell',label:'Shell',count:1,failed:false},{key:'app:miro',label:'Miro',app:'miro',count:1,failed:false}]);
  expect(state.actions).toBe(2);
 });
 it('says what the agent is doing in one line',()=>{
  expect(ringStatusText('Pip',{kind:'thinking'},0)).toBe('Pip is thinking…');
  expect(ringStatusText('Pip',{kind:'command',since:1000},41_000)).toBe('Pip is waiting on a command · 40s');
  expect(ringStatusText('Pip',{kind:'command',since:0},75_000)).toBe('Pip is waiting on a command · 1m 15s');
  expect(ringStatusText('Pip',{kind:'app',label:'Fathom'},0)).toBe('Pip is using Fathom');
  expect(ringStatusText('Pip',{kind:'working'},0)).toBe('Pip is working');
 });
 it('keeps the last five actions',()=>{
  const state=ringState(Array.from({length:7},(_,index)=>action('miro',`Step ${index}`,'read','ok',index+1)),'Pip',0);
  expect(texts(state)).toEqual(['Miro · Step 6','Miro · Step 5','Miro · Step 4','Miro · Step 3','Miro · Step 2']);
  expect(state.actions).toBe(7);
 });
});

describe('finishedTurn',()=>{
 it('spans the turn from its start to its end',()=>{
  const events=[ev('agent.turn.started',{},1000),ev('tool.started',{tool:'shell_run'},2000),ev('tool.executed',{tool:'shell_run'},3000),ev('agent.turn.completed',{},253_000)];
  expect(finishedTurn(events,'Pip')).toEqual({since:1000,until:253_000,outcome:'done'});
 });
 it('reads a stopped and a failed turn',()=>{
  const read=()=>ev('tool.started',{tool:'fs_read'},1);
  expect(finishedTurn([ev('agent.turn.started',{},0),read(),ev('agent.turn.completed',{cancelled:true},5000)],'Pip')?.outcome).toBe('stopped');
  expect(finishedTurn([ev('wrapper.turn.started',{},0),read(),ev('wrapper.turn.failed',{error:'x'},5000)],'Pip')?.outcome).toBe('failed');
 });
 it("falls back to the agent's first and last events when the turn start is not loaded",()=>{
  expect(finishedTurn([ev('tool.started',{tool:'fs_read'},4000),ev('tool.executed',{tool:'fs_read'},9000)],'Pip')).toEqual({since:4000,until:9000,outcome:'done'});
 });
 it('has nothing to show for a reply written without any action',()=>{
  expect(finishedTurn([ev('agent.turn.started',{},0),ev('agent.turn.completed',{},17_000)],'Pip')).toBeNull();
 });
 it('counts an app call as an action',()=>{
  expect(finishedTurn([ev('agent.turn.started',{},0),action('miro','Get board','read','ok',1),ev('agent.turn.completed',{},2)],'Pip')).not.toBeNull();
 });
 it("ignores other agents' events and has nothing for an agent with none",()=>{
  expect(finishedTurn([ev('agent.turn.started',{},0,'agent:Ann')],'Pip')).toBeNull();
 });
 it('says how the turn went in one line',()=>{
  expect(finishedText('Pip',{since:1000,until:253_000,outcome:'done'})).toBe('Pip worked for 4m 12s');
  expect(finishedText('Pip',{since:0,until:12_000,outcome:'stopped'})).toBe('Pip stopped after 12s');
  expect(finishedText('Pip',{since:0,until:12_000,outcome:'failed'})).toBe('Pip failed after 12s');
 });
});
