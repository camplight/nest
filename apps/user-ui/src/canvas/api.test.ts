import {afterEach,describe,expect,it,vi} from 'vitest';
import {ApiError} from '../api';
import {CanvasConflict,deleteCanvas,getBoard,moveCard,withFreshVersion} from './api';

// The wrappers translate HTTP status into canvas errors; the browser suite covers the real API.
function respond(status:number,body:unknown){
  const fetch=vi.fn(async(_url:string,_init?:RequestInit)=>new Response(body===null?null:JSON.stringify(body),{status,headers:{'content-type':'application/json'}}));
  vi.stubGlobal('fetch',fetch);
  return fetch;
}
afterEach(()=>{vi.unstubAllGlobals();});

describe('canvas api',()=>{
  it('throws CanvasConflict with the current row on 409',async()=>{
    respond(409,{error:'Canvas changed',current:{channelId:'ch1',version:4}});
    const error=await moveCard('c1','ch1',{x:1,y:2,version:3}).catch(e=>e);
    expect(error).toBeInstanceOf(CanvasConflict);
    expect(error.current).toEqual({channelId:'ch1',version:4});
  });

  it('keeps the status of other failures',async()=>{
    respond(404,{error:'Not found'});
    const error=await getBoard('c1').catch(e=>e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(404);
  });

  it('passes the etag and version in the query',async()=>{
    const fetch=respond(200,{unchanged:true});
    expect(await getBoard('c1','abc')).toEqual({unchanged:true});
    expect(fetch.mock.calls[0][0]).toBe('/api/canvases/c1/board?etag=abc');
    respond(204,null);
    await deleteCanvas('c1',7);
    const last=(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(last[0]).toBe('/api/canvases/c1?version=7');
    expect((last[1] as RequestInit).method).toBe('DELETE');
  });

  describe('withFreshVersion',()=>{
    it('retries once with the refreshed version after a conflict',async()=>{
      const run=vi.fn(async(version:number)=>{if(version===1)throw new CanvasConflict({version:2});return `ok ${version}`;});
      const fresh=vi.fn(async()=>2);
      expect(await withFreshVersion(1,fresh,run)).toBe('ok 2');
      expect(run.mock.calls.map(call=>call[0])).toEqual([1,2]);
      expect(fresh).toHaveBeenCalledTimes(1);
    });

    it('surfaces a second conflict and does not retry other errors',async()=>{
      const conflict=vi.fn(async(_version:number)=>{throw new CanvasConflict(null);});
      await expect(withFreshVersion(1,async()=>2,conflict)).rejects.toBeInstanceOf(CanvasConflict);
      expect(conflict).toHaveBeenCalledTimes(2);
      const other=vi.fn(async(_version:number)=>{throw new ApiError('nope',500);});
      const fresh=vi.fn(async()=>2);
      await expect(withFreshVersion(1,fresh,other)).rejects.toBeInstanceOf(ApiError);
      expect(other).toHaveBeenCalledTimes(1);
      expect(fresh).not.toHaveBeenCalled();
    });
  });
});
