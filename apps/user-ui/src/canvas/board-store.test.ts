import {afterEach,describe,expect,it,vi} from 'vitest';
import type {BoardCard,CanvasArea,CanvasBoard,CanvasCardRow} from '@nest/schemas';
import {ApiError} from '../api';
import {CanvasConflict} from './api';
import {createBoardStore,type BoardApi} from './board-store';

// UI state only: the fake api stands in for canvas/api.ts, not for the engine boundary.
const card=(channelId:string,x:number,y:number,version=0):BoardCard=>({
  canvasId:'c1',channelId,x,y,w:280,version,placedBy:'h1',placedAt:1,access:'open',title:channelId,
  projectId:null,participants:[],archived:false,canManage:true,
});
const board=(etag:string,cards:BoardCard[]=[card('ch1',0,0)]):CanvasBoard=>({
  canvas:{id:'c1',ownerId:'h1',name:'Launch',visibility:'private',version:1,createdAt:1,updatedAt:1,role:'owner'},
  areas:[],cards,etag,
});
function deferred<T>(){
  let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;
  const promise=new Promise<T>((ok,fail)=>{resolve=ok;reject=fail;});
  return {promise,resolve,reject};
}
function fakeApi(overrides:Partial<BoardApi>={}):BoardApi&{getBoard:ReturnType<typeof vi.fn>}{
  return {
    getBoard:vi.fn(async()=>board('e1')),
    moveCard:vi.fn(async()=>{throw Error('unexpected');}),
    removeCard:vi.fn(async()=>{}),
    placeCards:vi.fn(async()=>board('e2')),
    createArea:vi.fn(async()=>{throw Error('unexpected');}),
    patchArea:vi.fn(async()=>{throw Error('unexpected');}),
    deleteArea:vi.fn(async()=>{}),
    ...overrides,
  } as BoardApi&{getBoard:ReturnType<typeof vi.fn>};
}
function fakePage(state:DocumentVisibilityState='visible'){
  const doc=Object.assign(new EventTarget(),{visibilityState:state});
  const win=new EventTarget();
  return {doc,win,hide(){doc.visibilityState='hidden';doc.dispatchEvent(new Event('visibilitychange'));},show(){doc.visibilityState='visible';doc.dispatchEvent(new Event('visibilitychange'));}};
}

afterEach(()=>{vi.useRealTimers();});

describe('createBoardStore',()=>{
  it('applies an optimistic card move before the request resolves, then confirms its version',async()=>{
    const pending=deferred<CanvasCardRow>();
    const api=fakeApi({moveCard:vi.fn(()=>pending.promise)});
    const store=createBoardStore({api,now:()=>0,intervalMs:5000});
    await store.open('c1');
    const done=store.apply({kind:'moveCard',channelId:'ch1',x:120,y:40});
    expect(store.snapshot().board?.cards[0]).toMatchObject({x:120,y:40});
    // Writes are queued, so the request goes out a microtask later with the card's confirmed version.
    await vi.waitFor(()=>expect(api.moveCard).toHaveBeenCalledWith('c1','ch1',{x:120,y:40,version:0}));
    expect(store.snapshot().board?.cards[0]).toMatchObject({x:120,y:40,version:0});
    pending.resolve({canvasId:'c1',channelId:'ch1',projectId:null,x:120,y:40,w:280,version:1,placedBy:'h1',placedAt:1,ownerLabel:'demo'});
    api.getBoard.mockResolvedValueOnce(board('e2',[card('ch1',120,40,1)]));
    await done;
    expect(store.snapshot().board?.cards[0]).toMatchObject({x:120,y:40,version:1});
    // The layout write bumped the canvas version, so the store re-reads the board with its etag.
    expect(api.getBoard).toHaveBeenLastCalledWith('c1','e1');
    expect(store.snapshot().board?.etag).toBe('e2');
  });

  it('keeps a queued later move of the same card when an earlier move is confirmed, taking only its version',async()=>{
    const first=deferred<CanvasCardRow>(),second=deferred<CanvasCardRow>();
    const row=(x:number,y:number,version:number):CanvasCardRow=>({canvasId:'c1',channelId:'ch1',projectId:null,x,y,w:280,version,placedBy:'h1',placedAt:1,ownerLabel:'demo'});
    const api=fakeApi({moveCard:vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)});
    const store=createBoardStore({api,now:()=>0,intervalMs:5000});
    await store.open('c1');
    const a=store.apply({kind:'moveCard',channelId:'ch1',x:100,y:10});
    const b=store.apply({kind:'moveCard',channelId:'ch1',x:300,y:30});
    expect(store.snapshot().board?.cards[0]).toMatchObject({x:300,y:30});
    await vi.waitFor(()=>expect(api.moveCard).toHaveBeenCalledTimes(1));
    first.resolve(row(100,10,1));
    // The later drag is still queued: the card stays where it was last dropped, with the confirmed version.
    await vi.waitFor(()=>expect(api.moveCard).toHaveBeenCalledTimes(2));
    expect(store.snapshot().board?.cards[0]).toMatchObject({x:300,y:30,version:1});
    expect(api.moveCard).toHaveBeenLastCalledWith('c1','ch1',{x:300,y:30,version:1});
    api.getBoard.mockResolvedValueOnce(board('e2',[card('ch1',300,30,2)]));
    second.resolve(row(300,30,2));
    expect(await a).toBe(true);expect(await b).toBe(true);
    expect(store.snapshot().board?.cards[0]).toMatchObject({x:300,y:30,version:2});
  });

  it('keeps a queued later area edit when an earlier one is confirmed, and moves nested areas with the area at once',async()=>{
    const first=deferred<{area:CanvasArea;cards:CanvasCardRow[];areas:CanvasArea[]}>(),second=deferred<{area:CanvasArea;cards:CanvasCardRow[];areas:CanvasArea[]}>();
    const area=(id:string,x:number,y:number,w:number,h:number,version=0,title=id):CanvasArea=>({id,canvasId:'c1',title,x,y,w,h,tint:'moss',version});
    const start={...board('e1',[card('in-inner',150,150)]),areas:[area('outer',0,0,1000,800),area('inner',100,100,400,300)]};
    const api=fakeApi({getBoard:vi.fn(async()=>start),patchArea:vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)});
    const store=createBoardStore({api,now:()=>0,intervalMs:5000});
    await store.open('c1');
    void store.apply({kind:'patchArea',areaId:'outer',patch:{x:200,y:0},moveCards:true});
    // The nested area and the card inside it follow the move before the server answers.
    expect(store.snapshot().board?.areas.find(a=>a.id==='inner')).toMatchObject({x:300,y:100});
    expect(store.snapshot().board?.cards[0]).toMatchObject({x:350,y:150});
    const renamed=store.apply({kind:'patchArea',areaId:'outer',patch:{title:'Launch content'}});
    await vi.waitFor(()=>expect(api.patchArea).toHaveBeenCalledTimes(1));
    first.resolve({area:area('outer',200,0,1000,800,1),cards:[{canvasId:'c1',channelId:'in-inner',projectId:null,x:350,y:150,w:280,version:1,placedBy:'h1',placedAt:1,ownerLabel:'demo'}],areas:[area('inner',300,100,400,300,1)]});
    await vi.waitFor(()=>expect(api.patchArea).toHaveBeenCalledTimes(2));
    expect(store.snapshot().board?.areas.find(a=>a.id==='outer')).toMatchObject({title:'Launch content',x:200,version:1});
    expect(api.patchArea).toHaveBeenLastCalledWith('c1','outer',{title:'Launch content',version:1},false);
    api.getBoard.mockResolvedValueOnce({unchanged:true});
    second.resolve({area:area('outer',200,0,1000,800,2,'Launch content'),cards:[],areas:[]});
    expect(await renamed).toBe(true);
    expect(store.snapshot().board?.areas.find(a=>a.id==='outer')).toMatchObject({title:'Launch content',version:2});
  });

  it('sends deletes with the version of the item it hid, including one an earlier queued write confirmed',async()=>{
    const moved=deferred<CanvasCardRow>();
    const area:CanvasArea={id:'a1',canvasId:'c1',title:'Plans',x:0,y:0,w:400,h:300,tint:'moss',version:4};
    const api=fakeApi({getBoard:vi.fn(async()=>({...board('e1'),areas:[area]})),moveCard:vi.fn(()=>moved.promise)});
    const store=createBoardStore({api,now:()=>0,intervalMs:5000});
    await store.open('c1');
    api.getBoard.mockResolvedValue({unchanged:true});
    expect(await store.apply({kind:'deleteArea',areaId:'a1'})).toBe(true);
    expect(store.snapshot().board?.areas).toEqual([]);
    expect(api.deleteArea).toHaveBeenCalledWith('c1','a1',4);
    void store.apply({kind:'moveCard',channelId:'ch1',x:10,y:10});
    // The move is already on the wire when the card is removed; its confirmed version must be the one deleted.
    await vi.waitFor(()=>expect(api.moveCard).toHaveBeenCalled());
    const removal=store.apply({kind:'removeCard',channelId:'ch1'});
    expect(store.snapshot().board?.cards).toEqual([]);
    moved.resolve({canvasId:'c1',channelId:'ch1',projectId:null,x:10,y:10,w:280,version:1,placedBy:'h1',placedAt:1,ownerLabel:'demo'});
    expect(await removal).toBe(true);
    expect(api.removeCard).toHaveBeenCalledWith('c1','ch1',1);
  });

  it('replaces the board from a fresh read and says so when a write conflicts',async()=>{
    const api=fakeApi({moveCard:vi.fn(async()=>{throw new CanvasConflict({channelId:'ch1',x:5,y:5,version:3});})});
    const store=createBoardStore({api,now:()=>0,intervalMs:5000});
    await store.open('c1');
    const fresh=board('e9',[card('ch1',5,5,3)]);
    api.getBoard.mockResolvedValueOnce(fresh);
    await store.apply({kind:'moveCard',channelId:'ch1',x:300,y:300});
    expect(api.getBoard).toHaveBeenLastCalledWith('c1');
    expect(store.snapshot().board).toBe(fresh);
    expect(store.snapshot().notice).toBe('Canvas changed. Refreshed.');
    expect(store.snapshot().status).toBe('ready');
  });

  it('marks the canvas gone on 404',async()=>{
    const api=fakeApi({getBoard:vi.fn(async()=>{throw new ApiError('{"error":"Not found"}',404);})});
    const store=createBoardStore({api,now:()=>0,intervalMs:5000});
    await store.open('c1');
    expect(store.snapshot().status).toBe('gone');
    expect(store.snapshot().board).toBeNull();
  });

  it('marks the canvas gone when a write answers 404',async()=>{
    const api=fakeApi({moveCard:vi.fn(async()=>{throw new ApiError('{"error":"Not found"}',404);})});
    const store=createBoardStore({api,now:()=>0,intervalMs:5000});
    await store.open('c1');
    await store.apply({kind:'moveCard',channelId:'ch1',x:1,y:1});
    expect(store.snapshot().status).toBe('gone');
  });

  it('keeps the same board object when refresh reports the etag unchanged',async()=>{
    const api=fakeApi();
    const store=createBoardStore({api,now:()=>0,intervalMs:5000});
    await store.open('c1');
    const before=store.snapshot();
    api.getBoard.mockResolvedValueOnce({unchanged:true});
    await store.refresh();
    expect(api.getBoard).toHaveBeenLastCalledWith('c1','e1');
    expect(store.snapshot().board).toBe(before.board);
    expect(store.snapshot()).toBe(before);
  });

  it('drops a read that started before a write and reads again once the write settles',async()=>{
    const stale=deferred<CanvasBoard>();
    const api=fakeApi({moveCard:vi.fn(async()=>({canvasId:'c1',channelId:'ch1',projectId:null,x:50,y:50,w:280,version:1,placedBy:'h1',placedAt:1,ownerLabel:'demo'}))});
    const store=createBoardStore({api,now:()=>0,intervalMs:5000});
    await store.open('c1');
    api.getBoard.mockReturnValueOnce(stale.promise).mockResolvedValueOnce(board('e3',[card('ch1',50,50,1)]));
    const polling=store.refresh();
    const moved=store.apply({kind:'moveCard',channelId:'ch1',x:50,y:50});
    // The write is confirmed while the older read is still out.
    await vi.waitFor(()=>expect(api.moveCard).toHaveBeenCalled());
    await new Promise(resolve=>setTimeout(resolve,0));
    stale.resolve(board('e-old',[card('ch1',0,0,0)]));
    await polling;
    expect(await moved).toBe(true);
    expect(store.snapshot().board?.cards[0]).toMatchObject({x:50,y:50});
    expect(store.snapshot().board?.etag).toBe('e3');
  });

  it('notifies subscribers on change and ignores a stale open',async()=>{
    const slow=deferred<CanvasBoard>();
    const api=fakeApi({getBoard:vi.fn().mockReturnValueOnce(slow.promise).mockResolvedValueOnce(board('e2'))});
    const store=createBoardStore({api,now:()=>0,intervalMs:5000});
    const listener=vi.fn();store.subscribe(listener);
    const first=store.open('old');
    await store.open('c1');
    slow.resolve(board('stale'));await first;
    expect(store.snapshot().board?.etag).toBe('e2');
    expect(listener).toHaveBeenCalled();
  });

  it('polls only while the page is visible and refreshes on focus',async()=>{
    vi.useFakeTimers();
    const page=fakePage();
    const api=fakeApi();
    let clock=0;
    const store=createBoardStore({api,now:()=>clock,intervalMs:5000,doc:page.doc,win:page.win});
    await store.open('c1');
    api.getBoard.mockResolvedValue({unchanged:true});
    store.start();
    const calls=()=>api.getBoard.mock.calls.length;
    const start=calls();
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls()).toBe(start+1);
    page.hide();
    await vi.advanceTimersByTimeAsync(20000);
    expect(calls()).toBe(start+1);
    clock=60000;page.show();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls()).toBe(start+2);
    clock=120000;page.win.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls()).toBe(start+3);
    store.stop();
    await vi.advanceTimersByTimeAsync(20000);
    expect(calls()).toBe(start+3);
  });
});
