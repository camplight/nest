import {describe,expect,it} from 'vitest';
import type {EventRow} from '../types';
import {buildTimeline} from './timeline';
import {appFilterStays,filterTimelineByApp,latestOwnMessageId} from './filter-app';

const tool=(id:string,type:string,command:string,createdAt:number):EventRow=>({id,type,source:'agent:Pip',channelId:'c1',payload:{tool:'shell_run',args:{command}},createdAt});
const msg=(id:string,source:string,text:string,createdAt:number):EventRow=>({id,type:'message.created',source,channelId:'c1',payload:{text},createdAt});
const GH='gh pr view 12 --repo acme/web';
const SLACK='node connections.mjs execute slack SLACK_SEND_MESSAGE {}';
const events=[
  msg('m1','human:alek','Please check the PR',1000),
  tool('t1','tool.started',GH,1100),tool('t2','tool.executed',GH,1200),
  tool('t3','tool.started',SLACK,1300),tool('t4','tool.executed',SLACK,1400),
  msg('m2','agent:Pip','Done',1500),
];
const items=buildTimeline(events,{currentUsername:'alek'});

describe('filterTimelineByApp',()=>{
  it('returns every item for no app',()=>{
    expect(filterTimelineByApp(items,null)).toBe(items);
  });
  it('keeps only that app\'s tool events and drops messages',()=>{
    const out=filterTimelineByApp(items,'github');
    expect(out.length).toBeGreaterThan(0);
    expect(out.every(item=>item.kind==='activity')).toBe(true);
    expect(out.flatMap(item=>item.kind==='activity'?item.events.map(event=>event.id):[]).sort()).toEqual(['t1','t2']);
  });
  it('drops activity with no event of the app',()=>{
    expect(filterTimelineByApp(items,'notion')).toEqual([]);
  });
});

describe('appFilterStays',()=>{
  it('stays for no filter or an app with calls in the loaded events',()=>{
    expect(appFilterStays(null,events)).toBe(true);
    expect(appFilterStays('github',events)).toBe(true);
  });
  it('lets go when the chosen app has no calls loaded',()=>{
    expect(appFilterStays('notion',events)).toBe(false);
    expect(appFilterStays('github',[msg('m1','human:alek','hi',1)])).toBe(false);
  });
});

describe('latestOwnMessageId',()=>{
  it('is the newest message the person sent, and changes when they send another',()=>{
    expect(latestOwnMessageId(events,'alek')).toBe('m1');
    expect(latestOwnMessageId([...events,msg('m3','human:alek','more',2000)],'alek')).toBe('m3');
  });
  it('ignores other people and agents; none gives null',()=>{
    expect(latestOwnMessageId(events,'sam')).toBeNull();
    expect(latestOwnMessageId([msg('m9','agent:Pip','x',1)],'alek')).toBeNull();
  });
});
