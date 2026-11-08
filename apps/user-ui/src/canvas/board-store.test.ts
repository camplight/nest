import {afterEach,describe,expect,it,vi} from 'vitest';
import type {BoardCard,CanvasBoard,CanvasCardRow} from '@nest/schemas';
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
