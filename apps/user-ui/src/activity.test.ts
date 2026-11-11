import {describe,it,expect} from 'vitest';
import {activity,activityDetails,activeAgentProgress,appLineDetails,appLinePhrase,appRedaction} from './activity';
import type {EventRow} from './types';
const event=(type:string,payload:unknown)=>({id:'fixture',type,payload,source:'agent:Demo',createdAt:1,channelId:'demo'} as EventRow);
describe('activity status meaning',()=>{
 it('distinguishes process success, failure and missing status',()=>{
  expect(activity(event('process.exited',{exitCode:0})).tone).toBe('success');
  expect(activity(event('process.exited',{exitCode:1}))).toMatchObject({tone:'danger',icon:'error'});
  expect(activity(event('process.exited',{})).tone).toBe('muted');
 });
 it('does not equate diagnostic output with a failed response',()=>{
  expect(activity(event('process.output',{stream:'STDERR',text:'warning'})).tone).toBe('muted');
 });
 it('retains original event data in technical details',()=>{
  const row=event('tool.failed',{tool:'Search',args:{query:'demo'},error:{code:'offline'}});
  expect(JSON.parse(activityDetails(row))).toEqual({event:row.type,source:row.source,payload:row.payload});
 });
});

describe('app calls in the timeline',()=>{
 const call=(command:string,type='tool.executed')=>({...event(type,{tool:'shell_run',args:{command},output:'SECRET-OUT'}),source:'agent:Pip'});
 const send=call('node scripts/connections.mjs execute c1 GMAIL_SEND_EMAIL < a.json');
 // The canvas flag on: the timeline is given what it knows about app calls in the loaded events.
 const on=appRedaction([]);
 it('names the agent, app, action and whether it read or changed',()=>{
  expect(activity(send,on).title).toBe('Pip · Gmail · Send email · changed');
  expect(activity(call('node scripts/connections.mjs execute c1 GMAIL_FETCH_EMAILS < a.json'),on).title).toBe('Pip · Gmail · Fetch emails · read');
 });
 it('keeps the tone of the event phase',()=>{
  expect(activity(call('gh pr view 1 -R acme/web','tool.failed'),on).tone).toBe('danger');
 });
 it('shows only tool, time, agent, kind and label in the details',()=>{
  const text=activityDetails(send,on);
  expect(JSON.parse(text)).toEqual({tool:'shell_run',time:'1970-01-01T00:00:00.001Z',agent:'Pip',kind:'change',label:null});
  for(const leak of ['a.json','connections.mjs','SECRET-OUT','args','output'])expect(text).not.toContain(leak);
  expect(JSON.parse(activityDetails(call('gh pr view 1 -R acme/web'),on)).label).toBe('acme/web');
 });
 it('leaves other tools and shell commands as they were',()=>{
  const ls=call('ls -la');
  expect(activity(ls,on).title).toBe('shell_run completed');
  expect(JSON.parse(activityDetails(ls,on)).payload.args.command).toBe('ls -la');
 });
 it('renders exactly as before Phase 2 with the canvas flag off (R20)',()=>{
  expect(activity(send).title).toBe('shell_run completed');
  expect(activity(send,null).title).toBe('shell_run completed');
  expect(JSON.parse(activityDetails(send))).toEqual({event:send.type,source:send.source,payload:send.payload});
  expect(JSON.parse(activityDetails(send,null))).toEqual({event:send.type,source:send.source,payload:send.payload});
 });
});

describe('app lines in the timeline',()=>{
 const tool=(id:string,type:string,command:string,at:number)=>({...event(type,{tool:'shell_run',args:{command},output:'SECRET-OUT'}),id,source:'agent:Pip',createdAt:at});
 const send='node scripts/connections.mjs execute c1 GMAIL_SEND_EMAIL < a.json';
 it('makes one line per call, paired with its result, and keeps non-app tools out of it',()=>{
  const rows=[tool('s1','tool.started',send,10),tool('e1','tool.executed',send,20),tool('r1','tool.executed','gh pr view 1 -R acme/web',30),tool('l1','tool.executed','ls -la',40),tool('s2','tool.started',send.replace('SEND','FETCH'),50)];
  const apps=appRedaction(rows,60);
  expect([...apps.lines.keys()]).toEqual(['s1','r1','s2']);
  expect([...apps.appEvents].sort()).toEqual(['e1','r1','s1','s2']);
  expect(apps.lines.get('s1')).toMatchObject({agent:'Pip',appName:'Gmail',action:'Send email',kind:'change',state:'done'});
  expect(apps.lines.get('s2')).toMatchObject({kind:'read',state:'running'});
  expect(appRedaction(rows,60+11*60_000).lines.get('s2')?.state).toBe('failed');
 });
 it('phrases each call as a lowercase clause, by state',()=>{
  const apps=appRedaction([tool('r1','tool.executed','gh pr merge 1 -R acme/web',30),tool('s1','tool.executed',send,40),tool('f1','tool.executed',send.replace('SEND_EMAIL','FETCH_EMAILS'),50),
   tool('g1','tool.executed','gh api -X DELETE /x -R acme/web',60),tool('p1','tool.started','gh issue create -R acme/web',70),tool('x1','tool.failed',send.replace('SEND_EMAIL','LIST_THINGS'),80)],90);
  const phrase=(id:string)=>appLinePhrase(apps.lines.get(id)!);
  expect(phrase('r1')).toBe('merged a PR in acme/web');
  expect(phrase('s1')).toBe('sent an email');
  expect(phrase('f1')).toBe('fetched emails');
  expect(phrase('g1')).toBe('called the GitHub API in acme/web');
  expect(phrase('p1')).toBe('creating an issue in acme/web');
  expect(phrase('x1')).toBe('tried to list things');
  const named=(app:string,action:string,state:'done'|'failed'='done')=>appLinePhrase({...apps.lines.get('s1')!,app,appName:app,action,state});
  expect(named('gmail','Reply to thread')).toBe('replied to thread');
  expect(named('gmail','Move to trash')).toBe('moved to trash');
  expect(named('trello','Add labels to an issue')).toBe('added labels to an issue');
  expect(named('gmail','Reply to thread','failed')).toBe('tried to reply to thread');
  expect(appLinePhrase({...apps.lines.get('r1')!,action:'pr list'})).toBe('listed PRs in acme/web');
  expect(appLinePhrase({...apps.lines.get('s1')!,state:'running'})).toBe('sending an email');
  expect(appLinePhrase({...apps.lines.get('s1')!,state:'failed'})).toBe('tried to send an email');
  expect(appLinePhrase({...apps.lines.get('s1')!,action:'Frobnicate URL'})).toBe('used frobnicate URL');
 });
 it('details are plain words with the same time format as the line, and show only allowed fields',()=>{
  const apps=appRedaction([tool('r1','tool.executed','gh pr view 1 -R acme/web',30),tool('s1','tool.executed',send,40),tool('s2','tool.failed',send,50)],60);
  const time=(t?:number)=>`T${t}`;
  const mail=apps.lines.get('s1')!;
  expect(appLineDetails(mail,time)).toBe('Gmail · sent an email\nchanged something outside Nest · done at T40');
  expect(appLineDetails(apps.lines.get('r1')!,time)).toBe('GitHub · viewed a PR in acme/web\nread something outside Nest · done at T30');
  expect(appLineDetails({...mail,state:'failed'},time)).toContain('tried to change something outside Nest · failed at T40');
  for(const shown of [appLineDetails(mail,time),appLineDetails(apps.lines.get('r1')!,time),appLinePhrase(mail)])for(const leak of ['a.json','connections.mjs','SECRET-OUT','shell_run','T40Z'])expect(shown).not.toContain(leak);
 });
 it('hides the start, output and exit of an app call\'s process, but not other processes',()=>{
  const proc=(id:string,type:string,payload:object)=>({...event(type,payload),id,source:'system:process-runner'});
  const rows=[tool('s1','tool.started',send,10),proc('p-start','process.started',{processId:'app',cmd:send}),
   proc('p-out','process.output',{processId:'app',text:'SECRET-OUT'}),proc('p-exit','process.exited',{processId:'app',exitCode:0}),
   proc('plain','process.started',{processId:'plain',cmd:'ls'}),tool('e1','tool.executed',send,20)];
  const apps=appRedaction(rows,30);
  expect([...apps.processEvents].sort()).toEqual(['p-exit','p-out','p-start']);
  // An output whose start is not loaded stays drawn, and redacted.
  expect(appRedaction([{...rows[2]}],30).processEvents.size).toBe(0);
 });
 it('turns a call that ran past ten minutes failed when the clock moves on',()=>{
  const rows=[tool('s1','tool.started',send,10)];
  expect(appRedaction(rows,20).lines.get('s1')?.state).toBe('running');
  expect(appRedaction(rows,10+11*60_000).lines.get('s1')?.state).toBe('failed');
 });
});

describe('app processes in the timeline (R22)',()=>{
 const meta={ownerAgentName:'Pip',targetAgentName:'Pip'};
 const proc=(type:string,id:string,payload:Record<string,unknown>)=>({...event(type,{...payload,...meta}),id,source:'system:process-runner'});
 const started=(processId:string,cmd:string)=>proc('process.started',`start-${processId}`,{processId,cmd,executionMode:'SYNC'});
 const output=(processId:string,text:string)=>proc('process.output',`out-${processId}`,{processId,seq:1,stream:'STDOUT',text});
 const exited=(processId:string)=>proc('process.exited',`exit-${processId}`,{processId,exitCode:0,signal:null,timedOut:false});
 const send='node scripts/connections.mjs execute c1 GMAIL_SEND_EMAIL < a.json';
 const rows=[started('p1',send),output('p1','SECRET-OUT'),exited('p1'),started('p2','ls -la'),output('p2','plain listing'),exited('p2'),started('p3','gh pr view 5 -R acme/web'),output('p3','PR body')];
 const on=appRedaction(rows);
 it('redacts the start, output and end of a process whose command is an app call, like its tool event',()=>{
  for(const row of rows.slice(0,3)){
   const text=activityDetails(row,on);
   expect(JSON.parse(text)).toEqual({event:row.type,time:'1970-01-01T00:00:00.001Z',agent:'Pip',kind:'change',label:null});
   for(const leak of ['a.json','connections.mjs','SECRET-OUT','cmd','text'])expect(text).not.toContain(leak);
  }
  expect(JSON.parse(activityDetails(rows[6],on))).toEqual({event:'process.started',time:'1970-01-01T00:00:00.001Z',agent:'Pip',kind:'read',label:'acme/web'});
  expect(activityDetails(rows[7],on)).not.toContain('PR body');
 });
 it('keeps the plain titles, which never name the command',()=>{
  expect(activity(rows[0],on).title).toBe('Agent process started');
  expect(activity(rows[1],on).title).toBe('Agent output');
 });
 it('leaves other processes as they were',()=>{
  for(const row of rows.slice(3,6))expect(JSON.parse(activityDetails(row,on))).toEqual({event:row.type,source:row.source,payload:row.payload});
 });
 it('hides output whose process start is not loaded, since its command is unknown',()=>{
  const orphan=output('p9','MAYBE-SECRET');
  const text=activityDetails(orphan,appRedaction([orphan]));
  expect(text).not.toContain('MAYBE-SECRET');
  expect(JSON.parse(text)).toMatchObject({event:'process.output',agent:'Pip'});
 });
 it('shows every payload as before with the canvas flag off (R20)',()=>{
  for(const row of rows)expect(JSON.parse(activityDetails(row))).toEqual({event:row.type,source:row.source,payload:row.payload});
 });
});

describe('compact wrapped progress',()=>{
 const progress=(id:string,triggerEventId='turn',source='agent:Demo')=>({...event('agent.turn.phase',{phase:'codex-progress',text:'Waiting for checks.',triggerEventId}),id,source});
 it('keeps only the latest update per turn across interleaved human messages',()=>{
  const rows=[progress('old'),event('message.created',{text:'Any update?'}),progress('latest'),progress('other','other-turn','agent:Other')];
  expect([...activeAgentProgress(rows)]).toEqual(['latest','other']);
  rows.push(event('agent.turn.completed',{triggerEventId:'turn'}));
  expect([...activeAgentProgress(rows)]).toEqual(['other']);
 });
 it('clears failed or completed wrapper updates, including late transport arrivals',()=>{
  const done={...event('wrapper.turn.failed',{targetAgentName:'Demo',triggerEventId:'turn'}),source:'system:runner:wrapper'};
  expect([...activeAgentProgress([progress('old'),done,progress('late')])]).toEqual([]);
 });
 it('does not reuse a previous turn update or expose arbitrary phase payloads',()=>{
  expect([...activeAgentProgress([progress('old'),event('agent.turn.started',{triggerEventId:'next'}),event('agent.turn.phase',{text:'private detail'})])]).toEqual([]);
 });
 it('shows progress when the engine retries a previously failed trigger',()=>{
  expect([...activeAgentProgress([event('agent.turn.failed',{triggerEventId:'turn'}),event('agent.turn.started',{triggerEventId:'turn'}),progress('retry')])]).toEqual(['retry']);
 });
});
