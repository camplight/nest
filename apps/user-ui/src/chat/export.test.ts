import {describe,expect,it} from 'vitest';
import {chatToMarkdown,messageLink} from './export';
import {buildTimeline} from './timeline';
import type {EventRow} from '../types';

// Synthetic fixture: 2026-01-02 03:04 UTC and two minutes later.
const T0=Date.UTC(2026,0,2,3,4);
const events:EventRow[]=[
 {id:'e1',type:'message.created',source:'human:synthetic-owner',payload:{text:'Synthetic **hello**'},createdAt:T0},
 {id:'t1',type:'tool.started',source:'agent:Pip',payload:{tool:'Search',args:{query:'synthetic query'}},createdAt:T0+10_000},
 {id:'t2',type:'process.output',source:'agent:Pip',payload:{stderr:'SECRET'},createdAt:T0+20_000},
 {id:'t3',type:'tool.executed',source:'agent:Pip',payload:{tool:'Search',output:'synthetic tool output'},createdAt:T0+30_000},
 {id:'e2',type:'message.created',source:'agent:Pip',payload:{text:'Synthetic reply',attachments:[{fileId:'f1',name:'report.txt',mime:'text/plain',size:12}]},createdAt:T0+120_000},
];
const items=buildTimeline(events,{currentUsername:'synthetic-owner'});

describe('chatToMarkdown',()=>{
 it('exports messages, one activity count line and attachment links',()=>{
  expect(items.map(item=>item.kind)).toEqual(['message','activity','message']);
  const markdown=chatToMarkdown(items,{channelLabel:'Synthetic channel',timeZone:'UTC'});
  expect(markdown.split('\n')[0]).toBe('# Synthetic channel');
  expect(markdown).toContain('**synthetic-owner** · 2026-01-02 03:04\nSynthetic **hello**');
  expect(markdown).toContain('**Pip** · 2026-01-02 03:06\nSynthetic reply');
  expect(markdown).toContain('_Agent activity: 3 events_');
  expect(markdown).toContain('[report.txt](/api/files/f1)');
  expect(markdown).toBe([
   '# Synthetic channel','',
   '**synthetic-owner** · 2026-01-02 03:04','Synthetic **hello**','',
   '_Agent activity: 3 events_','',
   '**Pip** · 2026-01-02 03:06','Synthetic reply','[report.txt](/api/files/f1)','',
  ].join('\n'));
 });
 it('never serialises activity payloads (spec 5.6)',()=>{
  const markdown=chatToMarkdown(items,{channelLabel:'Synthetic channel',timeZone:'UTC'});
  for(const leak of ['SECRET','synthetic query','synthetic tool output','Search','stderr'])expect(markdown).not.toContain(leak);
 });
});

describe('messageLink',()=>{
 it('replaces the message param and keeps the others in order',()=>{
  expect(messageLink('e1','https://h/?view=projects&project=p&message=old')).toBe('https://h/?view=projects&project=p&message=e1');
 });
 it('adds the message param when absent',()=>{
  expect(messageLink('e2','https://h/?channel=c')).toBe('https://h/?channel=c&message=e2');
 });
});
