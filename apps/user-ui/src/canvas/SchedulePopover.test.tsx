import {describe,expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import type {TriggerView} from '@nest/schemas';
import {SchedulePopover,type SchedulePopoverProps} from './SchedulePopover';

const props:SchedulePopoverProps={chat:{channelId:'c1',title:'Recap'},schedule:null,agents:['Pip'],pinned:[],timezone:'UTC',anchor:null,now:()=>0,
  onSave:async()=>true,onSaveWebhook:async()=>true,onClose:()=>{}};
const kinds=(html:string)=>[...html.matchAll(/<button type="button" class="pick txt[^"]*"[^>]*>([^<]*)</g)].map(m=>m[1]);
const appTrigger:TriggerView={id:'t9',channelId:'c1',agent:'Pip',prompt:'Triage it',label:'New commits',kind:'app',app:'github',triggerSlug:'GITHUB_COMMIT_EVENT',config:{},on:true,pausedReason:null,
  tokenHint:'',lastAt:null,createdBy:'me',createdAt:1,rotatedAt:1,updatedAt:1,version:0,canEdit:true,canManage:true};

describe('SchedulePopover kinds',()=>{
  it('offers App event after Webhook only when app events are available',()=>{
    const apps={appEvents:true,loadApps:async()=>[],loadTypes:async()=>[],onSaveApp:async()=>null};
    expect(kinds(renderToStaticMarkup(<SchedulePopover {...props} webhooks/>)).slice(-2)).toEqual(['Every few minutes','Webhook']);
    expect(kinds(renderToStaticMarkup(<SchedulePopover {...props} webhooks {...apps}/>)).slice(-2)).toEqual(['Webhook','App event']);
    expect(kinds(renderToStaticMarkup(<SchedulePopover {...props} webhooks {...apps} appEvents={false}/>))).not.toContain('App event');
  });
  it('shows an existing app event as one: its app and event, no URL and no Rotate URL',()=>{
    const html=renderToStaticMarkup(<SchedulePopover {...props} trigger={appTrigger} webhooks appEvents onRotate={async()=>{}}/>);
    expect(kinds(html)).toEqual(['App event']);
    expect(html).toContain('github · Commit event');
    expect(html).not.toContain('Rotate URL');
    expect(html).not.toContain('Webhook URL');
    expect(html).toContain('When the app event happens');
  });
});
