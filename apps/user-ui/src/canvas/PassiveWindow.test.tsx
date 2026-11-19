import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {ActiveWindowBody,PassiveWindow} from './PassiveWindow';
import type {ChannelEventsCore,ChannelEventsSnapshot} from '../chat/channel-events';
import type {EventRow} from '../types';

const message:EventRow={id:'e1',type:'message.created',source:'agent:Pip',channelId:'c1',createdAt:1000,payload:{text:'Launch notes are drafted'}};
const snapshot:ChannelEventsSnapshot={channelId:'c1',events:[message],detachedIds:new Set(),loading:false,loadingOlder:false,hasOlder:false,error:null};
// Only what a read-only thread reads: the snapshot, a subscription and older pages.
const core={snapshot:()=>snapshot,subscribe:()=>()=>{},loadOlder:async()=>{}} as unknown as ChannelEventsCore;
const noop=()=>{};
const bounds={left:16,top:16,right:1200,bottom:800};

describe('PassiveWindow',()=>{
  // Message bodies read the page origin (demo links); the node test run has no window.
  beforeEach(()=>{vi.stubGlobal('window',{location:{origin:'http://localhost'}});});
  afterEach(()=>{vi.unstubAllGlobals();});
  it('shows title, close, live thread and "Click to reply", and no composer',()=>{
    const html=renderToStaticMarkup(<PassiveWindow win={{channelId:'c1',x:40,y:60}} bounds={bounds} zIndex={22} title="Launch"
      people={[{agent:true,name:'Pip',service:false}]} core={core} username="mate" agents={[]} onActivate={noop} onClose={noop} onMove={noop}/>);
    expect(html).toContain('class="canvas-chat is-passive"');
    expect(html).toContain('Launch');
    expect(html).toContain('aria-label="Close chat Launch"');
    expect(html).toContain('Launch notes are drafted');
    expect(html).toContain('Click to reply');
    expect(html).not.toContain('textarea');
    expect(html).not.toContain('aria-modal');
  });
});

describe('ActiveWindowBody',()=>{
  it('shows the passive thread until ready',()=>{
    const passive=<div className="passive-marker"/>;
    const waiting=renderToStaticMarkup(<ActiveWindowBody ready={false} passive={passive}><p>composer</p></ActiveWindowBody>);
    expect(waiting).toContain('passive-marker');
    expect(waiting).not.toContain('composer');
    const ready=renderToStaticMarkup(<ActiveWindowBody ready passive={passive}><p>composer</p></ActiveWindowBody>);
    expect(ready).toContain('composer');
    expect(ready).not.toContain('passive-marker');
  });
});
