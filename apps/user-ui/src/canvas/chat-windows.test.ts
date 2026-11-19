import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {MAX_WINDOWS,bringToFront,clampWindow,closeWindow,moveWindow,openWindow,placeWindow,pruneWindows,readWindows,windowHeight,windowWidth,writeWindows,type ChatWindow} from './chat-windows';

const bounds={left:0,top:0,right:1600,bottom:900};
const win=(channelId:string,x=0,y=0):ChatWindow=>({channelId,x,y});
const ids=(list:readonly ChatWindow[])=>list.map(w=>w.channelId);

describe('chat window list',()=>{
  it('openWindow adds at the front',()=>{
    expect(openWindow([],'a',{x:10,y:20},null)).toEqual([win('a',10,20)]);
  });
  it('openWindow on an open chat brings it to the front without moving it',()=>{
    expect(openWindow([win('b',0,0),win('a',5,5)],'a',{x:99,y:99},null)).toEqual([win('a',5,5),win('b',0,0)]);
  });
  it('openWindow caps at 4 by closing the back-most non-active window',()=>{
    const list=[win('d'),win('c'),win('b'),win('a')];
    expect(ids(openWindow(list,'e',{x:0,y:0},'a'))).toEqual(['e','d','c','a']);
    expect(ids(list)).toEqual(['d','c','b','a']);
    expect(MAX_WINDOWS).toBe(4);
  });
  it('closeWindow returns the next front window',()=>{
    expect(closeWindow([win('a'),win('b'),win('c')],'a')).toEqual({list:[win('b'),win('c')],next:'b'});
    expect(closeWindow([win('a')],'a')).toEqual({list:[],next:null});
  });
  it('bringToFront moves the window to index 0 and keeps the others\' order',()=>{
    expect(ids(bringToFront([win('a'),win('b'),win('c'),win('d')],'c'))).toEqual(['c','a','b','d']);
  });
  it('moveWindow clamps into the bounds',()=>{
    const moved=moveWindow([win('a')],'a',{x:-50,y:2000},bounds)[0];
    expect(moved.x).toBe(0);
    expect(moved.y).toBe(900-windowHeight(bounds));
  });
  it('clampWindow pulls a window back after the stage shrinks',()=>{
    const small={left:0,top:0,right:1000,bottom:600};
    const clamped=clampWindow(win('a',1500,800),small);
    expect(clamped.x).toBe(1000-windowWidth(small));
    expect(clamped.y).toBe(600-windowHeight(small));
  });
  it('windowWidth is 440 wide, 360 in a 360 stage and never below 320',()=>{
    expect(windowWidth(bounds)).toBe(440);
    expect(windowWidth({left:0,top:0,right:360,bottom:900})).toBe(360);
    expect(windowWidth({left:0,top:0,right:200,bottom:900})).toBe(320);
  });
  it('placeWindow goes right of a card, left when there is no room, cascades from the front, else top-left',()=>{
    expect(placeWindow({x:100,y:50,w:280},null,bounds)).toEqual({x:100+280+16,y:50});
    const left=placeWindow({x:1200,y:50,w:280},null,bounds);
    expect(left).toEqual({x:1200-16-440,y:50});
    expect(placeWindow(null,win('f',200,100),bounds)).toEqual({x:232,y:132});
    expect(placeWindow(null,null,bounds)).toEqual({x:16,y:16});
    const low=placeWindow({x:100,y:5000,w:280},null,bounds);
    expect(low.y).toBe(900-windowHeight(bounds));
  });
  it('pruneWindows drops ids not allowed and keeps order',()=>{
    expect(ids(pruneWindows([win('a'),win('b'),win('c')],new Set(['c','a'])))).toEqual(['a','c']);
  });
});

describe('chat window persistence',()=>{
  const original=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage');
  const install=(store:unknown)=>Object.defineProperty(globalThis,'sessionStorage',{value:store,configurable:true,writable:true});
  const memory=()=>{const m=new Map<string,string>();return {getItem:(k:string)=>m.get(k)??null,setItem:(k:string,v:string)=>{m.set(k,v);},m};};
  beforeEach(()=>install(memory()));
  afterEach(()=>{if(original)Object.defineProperty(globalThis,'sessionStorage',original);else delete (globalThis as {sessionStorage?:unknown}).sessionStorage;});

  it('round-trips per canvas',()=>{
    const list=[win('a',1,2),win('b',3,4)];
    writeWindows('cv1',list);
    expect(readWindows('cv2')).toEqual([]);
    expect(readWindows('cv1')).toEqual(list);
  });
  it('treats malformed JSON as empty',()=>{
    const store=memory();install(store);
    store.setItem('nest-canvas-windows:cv1','{nope');
    expect(readWindows('cv1')).toEqual([]);
  });
  it('survives a storage that throws',()=>{
    const boom=()=>{throw new Error('denied');};
    install({getItem:boom,setItem:boom});
    expect(readWindows('cv1')).toEqual([]);
    expect(()=>writeWindows('cv1',[win('a')])).not.toThrow();
  });
  it('never returns more than MAX_WINDOWS or duplicate ids, and drops bad entries',()=>{
    const store=memory();install(store);
    store.setItem('nest-canvas-windows:cv1',JSON.stringify([win('a'),win('a',9,9),win('b'),{channelId:3},null,win('c'),win('d'),win('e')]));
    expect(ids(readWindows('cv1'))).toEqual(['a','b','c','d']);
  });
});
