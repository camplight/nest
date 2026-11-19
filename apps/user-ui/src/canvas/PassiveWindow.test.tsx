import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {ActiveWindowBody,PassiveWindow,passiveActivation} from './PassiveWindow';
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
  beforeEach(()=>{
    vi.stubGlobal('window',{location:{origin:'http://localhost'}});
    // renderToStaticMarkup warns that layout effects do nothing on the server; that is expected here.
    const original=console.error;
    vi.spyOn(console,'error').mockImplementation((...args:unknown[])=>{if(!String(args[0]).includes('useLayoutEffect does nothing on the server'))original(...args);});
  });
  afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
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

describe('passiveActivation',()=>{
  const section={};
  const fake=(target:object,key?:string)=>({target,currentTarget:section,key,preventDefault:vi.fn()}) as never;
  it('activates when the window itself takes focus, not when Tab lands on something inside',()=>{
    const onActivate=vi.fn(),{onFocus}=passiveActivation(onActivate);
    onFocus(fake({}));
    expect(onActivate).not.toHaveBeenCalled();
    onFocus(fake(section));
    expect(onActivate).toHaveBeenCalledTimes(1);
  });
  it('activates on Enter or Space while the window itself is focused only',()=>{
    const onActivate=vi.fn(),{onKeyDown}=passiveActivation(onActivate);
    onKeyDown(fake({},'Enter'));
    onKeyDown(fake(section,'a'));
    expect(onActivate).not.toHaveBeenCalled();
    onKeyDown(fake(section,'Enter'));
    onKeyDown(fake(section,' '));
    expect(onActivate).toHaveBeenCalledTimes(2);
  });
});
