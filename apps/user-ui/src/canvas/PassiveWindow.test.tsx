import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {ActiveWindowBody,PassiveWindow,conversationEmpty,passiveActivation,pressOnScrollbar} from './PassiveWindow';
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
    // In the Tab order, so the keyboard can reach it and activate it with Enter or Space.
    expect(html).toContain('tabindex="0"');
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
  it('never activates on focus, so Tab passes through without swapping windows',()=>{
    expect(passiveActivation(vi.fn())).not.toHaveProperty('onFocus');
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

describe('conversationEmpty',()=>{
  const at=(events:EventRow[],loading=false)=>({...snapshot,events,loading});
  it('is empty once loaded with no message or agent activity',()=>{
    expect(conversationEmpty(at([]))).toBe(true);
    expect(conversationEmpty(at([{...message,id:'j',type:'channel.participant.added'}]))).toBe(true);
  });
  it('is not empty while loading, or with a message or a trace event',()=>{
    expect(conversationEmpty(at([],true))).toBe(false);
    expect(conversationEmpty(at([message]))).toBe(false);
    expect(conversationEmpty(at([{...message,id:'t',type:'agent.turn.started'}]))).toBe(false);
  });
});

describe('pressOnScrollbar',()=>{
  // A 300 x 400 thread at (100, 50) with a 12 px scrollbar on the right: its client box is 288 px wide.
  const thread=(scrollHeight=1200)=>({clientLeft:0,clientTop:0,clientWidth:288,clientHeight:400,scrollWidth:288,scrollHeight,getBoundingClientRect:()=>({left:100,top:50})});
  it('is a scrollbar press only outside the client box of something that scrolls',()=>{
    expect(pressOnScrollbar(thread(),100+294,200)).toBe(true);
    expect(pressOnScrollbar(thread(),100+200,200)).toBe(false);
    expect(pressOnScrollbar(thread(400),100+294,200)).toBe(false);
  });
  it('counts a scrollbar on the left (right-to-left) by the client box offset',()=>{
    const rtl={...thread(),clientLeft:12};
    expect(pressOnScrollbar(rtl,100+6,200)).toBe(true);
    expect(pressOnScrollbar(rtl,100+20,200)).toBe(false);
  });
});
