import {afterEach,describe,expect,it,vi} from 'vitest';
import {ApiError} from '../api';
import {CanvasConflict,deleteCanvas,getBoard,moveCard} from './api';

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
});
