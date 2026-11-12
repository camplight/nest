import {describe,expect,it} from 'vitest';
import type {AgentMadeSchedule,ScheduleRun,ScheduleView,TriggerView} from '@nest/schemas';
import {agentMadeCount,badgeOf,jobsByChannel,listGroups,rowWhen,scheduleJobs,scheduledCount,setupChip,stripState} from './schedule-jobs';

// Monday 2026-11-16 09:00 UTC.
const MON_0900=Date.UTC(2026,10,16,9,0);
const H=3_600_000;
const view=(over:Partial<ScheduleView>={}):ScheduleView=>({
  id:'s1',channelId:'c1',agent:'Pip',prompt:'Post the weekly recap.',rule:{kind:'weekly',days:[0,2],time:'09:00'},timezone:'UTC',
  on:true,pausedReason:null,nextAt:MON_0900,createdBy:'me',createdAt:1,updatedAt:1,version:0,lastRun:null,chatTitle:'Recap',canEdit:true,canManage:true,...over,
});
const run=(over:Partial<ScheduleRun>):ScheduleRun=>({id:'r1',scheduleId:'s1',dueAt:MON_0900-7*24*H,eventId:null,kind:'scheduled',status:'started',reason:null,createdAt:1,...over});
const pom:AgentMadeSchedule={eventId:'e1',channelId:'c2',agent:'Pom',at:MON_0900+2*H,text:'Check the build'};
const jobs=(schedules:ScheduleView[],agentMade:AgentMadeSchedule[]=[])=>scheduleJobs({schedules,agentMade,viewerId:'me',names:new Map([['mate','mate']]),tz:'UTC'});

describe('scheduled jobs',()=>{
  it('reads a schedule as the mock does: rule, short rule, next run and no `set by` for the viewer\'s own',()=>{
    const [job]=jobs([view()]);
    expect(job).toMatchObject({text:'Every Monday, Wednesday at 09:00',short:'Mon Wed 09:00',setBy:null,on:true,next:MON_0900,missed:null,lastOk:null});
    expect(stripState(job,MON_0900-3*24*H)).toBe('next in 3 days');
    expect(badgeOf([job])).toEqual({kind:'on',text:'Mon Wed 09:00',title:'Every Monday, Wednesday at 09:00'});
    expect(setupChip([job])).toEqual({text:'Mon Wed 09:00',warn:false});
  });
  it('names another creator, and an agent that booked its own run, as `set by`',()=>{
    const [mine,theirs,agent]=jobs([view(),view({id:'s2',createdBy:'mate'})],[pom]);
    expect([mine.setBy,theirs.setBy,agent.setBy]).toEqual([null,'mate','Pom']);
    expect(agent).toMatchObject({text:'Once · Mon 11:00',short:'Once Mon 11:00',schedule:null,on:true,next:pom.at});
  });
  it('a missed last run makes the badge `missed`, the chip `missed run` and the strip say when and why',()=>{
    const [job]=jobs([view({lastRun:run({status:'missed',reason:'agent stopped',dueAt:MON_0900})})]);
    expect(job.missed).toEqual({at:'Mon 09:00',reason:'agent stopped'});
    expect(badgeOf([job])).toMatchObject({kind:'missed',text:'missed'});
    expect(setupChip([job])).toEqual({text:'missed run',warn:true});
    expect(scheduledCount([job])).toEqual({text:'1 missed',hot:true});
    expect(rowWhen(job,MON_0900)).toEqual(['Missed Mon 09:00','agent stopped']);
  });
  it('a started last run reads `last run … ✓`; a paused schedule is `off` and `paused`',()=>{
    const [ok]=jobs([view({lastRun:run({})})]);
    expect(ok.lastOk).toBe('Mon 09:00');
    const [paused]=jobs([view({on:false,nextAt:null})]);
    expect(badgeOf([paused])?.kind).toBe('off');
    expect(stripState(paused,0)).toBe('paused');
    expect(rowWhen(paused,0)).toEqual(['Paused','']);
    expect(scheduledCount([ok,paused])).toEqual({text:'1',hot:false});
  });
  it('the badge prefers a missed job, then a live one, and counts the rest',()=>{
    const list=jobs([view({on:false,nextAt:null}),view({id:'s2',rule:{kind:'daily',time:'08:00'}})]);
    expect(badgeOf(list)).toEqual({kind:'on',text:'Daily 08:00 +1',title:'Every day at 08:00 (+1 more)'});
  });
  it('groups the list: Missed, Next 24 hours, Later, Paused; `Set by agents` keeps agents\' own runs',()=>{
    const list=jobs([
      view({id:'missed',lastRun:run({status:'missed',reason:'no turn started'})}),
      view({id:'later',nextAt:MON_0900+3*24*H}),
      view({id:'soon',nextAt:MON_0900+H}),
      view({id:'paused',on:false,nextAt:null}),
    ],[pom]);
    const groups=listGroups(list,'all',MON_0900);
    expect(groups.map(g=>[g.title,g.jobs.map(j=>j.key)])).toEqual([
      ['Missed',['missed']],['Next 24 hours',['soon','agent:e1']],['Later',['later']],['Paused',['paused']],
    ]);
    expect(listGroups(list,'agents',MON_0900).map(g=>[g.title,g.jobs.map(j=>j.key)])).toEqual([['Next 24 hours',['agent:e1']]]);
    expect(rowWhen(list[2],MON_0900)).toEqual(['Mon 10:00','in 1 h']);
  });
  it('keeps a chat\'s array when its jobs read the same, so its card does not re-render',()=>{
    const first=jobsByChannel(jobs([view()],[pom]));
    const again=jobsByChannel(jobs([view()],[pom]),first);
    expect(again.get('c1')).toBe(first.get('c1'));
    const changed=jobsByChannel(jobs([view({on:false,nextAt:null})],[pom]),first);
    expect(changed.get('c1')).not.toBe(first.get('c1'));
    expect(changed.get('c2')).toBe(first.get('c2'));
  });
  it('a webhook waits for its call: `On event`, `last …`, listed under Starts when something happens, never Set by agents',()=>{
    const hook=(over:Partial<TriggerView>={}):TriggerView=>({id:'t1',channelId:'c1',agent:'Pip',prompt:'Triage it',label:'Sentry',on:true,pausedReason:null,tokenHint:'abcd',
      lastAt:null,createdBy:'me',createdAt:1,rotatedAt:1,updatedAt:1,version:0,canEdit:true,canManage:true,...over});
    const all=scheduleJobs({schedules:[view()],agentMade:[pom],triggers:[hook(),hook({id:'t2',createdBy:'mate',lastAt:MON_0900-H})],viewerId:'me',names:new Map([['mate','mate']]),tz:'UTC'});
    const [,waiting,called]=all;
    expect(waiting).toMatchObject({key:'hook:t1',text:'When the webhook is called',short:'webhook',label:'Sentry',next:null,on:true,setBy:null,schedule:null,lastOk:null});
    expect(waiting.trigger?.id).toBe('t1');
    expect(called).toMatchObject({setBy:'mate',lastOk:'Mon 08:00'});
    expect(stripState(waiting,MON_0900)).toBe('waiting for it');
    expect(rowWhen(waiting,MON_0900)).toEqual(['On event','waiting']);
    expect(rowWhen(called,MON_0900)).toEqual(['On event','last Mon 08:00']);
    expect(listGroups(all,'all',MON_0900-H).map(g=>[g.title,g.jobs.map(j=>j.key)])).toEqual([
      ['Starts when something happens',['hook:t1','hook:t2']],['Next 24 hours',['s1','agent:e1']],
    ]);
    expect(listGroups(all,'agents',MON_0900).flatMap(g=>g.jobs.map(j=>j.key))).toEqual(['agent:e1']);
    expect(agentMadeCount(all)).toBe(1);
    expect(setupChip([waiting])).toEqual({text:'webhook',warn:false});
    expect(scheduledCount(all)).toEqual({text:'4',hot:false});
    const [paused]=scheduleJobs({schedules:[],agentMade:[],triggers:[hook({on:false})],viewerId:'me',names:new Map(),tz:'UTC'});
    expect(badgeOf([paused])).toMatchObject({kind:'off',text:'webhook'});
    expect(listGroups([paused],'all',MON_0900).map(g=>g.title)).toEqual(['Paused']);
  });
});
