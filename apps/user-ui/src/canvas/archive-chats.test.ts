import {describe,expect,it} from 'vitest';
import {archiveOrHide} from './archive-chats';
import type {LooseChat} from './loose';

const row=(channelId:string,patch:Partial<LooseChat>={}):LooseChat=>({channelId,projectId:null,title:channelId,participants:[],lastActivityAt:null,agents:[],state:'done',reason:null,line:'',manageable:true,archived:false,...patch});
function deps(chats:LooseChat[],refuse:string[]=[],hidden:string[]=[]) {
  const calls={engine:[] as string[],hide:[] as {ids:string[];hidden:boolean}[],refreshed:0};
  let stored=new Set(hidden);
  return {calls,deps:{
    chats,hidden:new Set(hidden),
    engineArchive:async(id:string,archived:boolean)=>{calls.engine.push(`${archived?'archive':'unarchive'}:${id}`);return !refuse.includes(id);},
    setHidden:async(ids:string[],value:boolean)=>{calls.hide.push({ids,hidden:value});for(const id of ids)value?stored.add(id):stored.delete(id);return {channelIds:[...stored]};},
    refresh:async()=>{calls.refreshed+=1;},
  }};
}

describe('archiveOrHide',()=>{
  it('archives the chats the person manages, hides the rest, and says so',async()=>{
    const {calls,deps:d}=deps([row('a'),row('b',{manageable:false}),row('c')]);
    const result=await archiveOrHide(['a','b','c'],true,d);
    expect(calls.engine).toEqual(['archive:a','archive:c']);
    expect(calls.hide).toEqual([{ids:['b'],hidden:true}]);
    expect(calls.refreshed).toBe(1);
    expect(result).toEqual({ok:true,notice:"Archived 2 · hid 1 you can't manage",hidden:['b']});
  });
  it('keeps what the engine archived, never hides a refused chat instead, and names the failure',async()=>{
    const {calls,deps:d}=deps([row('a'),row('b'),row('c',{manageable:false})],['b']);
    const result=await archiveOrHide(['a','b','c'],true,d);
    expect(calls.hide).toEqual([{ids:['c'],hidden:true}]);
    expect(result.notice).toBe("Archived 1 · hid 1 you can't manage · 1 could not be archived. Try again.");
    expect(result.ok).toBe(true);
  });
  it('reports failure when the engine refused everything and nothing was hidden',async()=>{
    const {calls,deps:d}=deps([row('a')],['a']);
    expect(await archiveOrHide(['a'],true,d)).toEqual({ok:false,notice:null,hidden:null});
    expect(calls.refreshed).toBe(0);
  });
  it('undo unarchives an archived chat and unhides a hidden one',async()=>{
    const {calls,deps:d}=deps([row('a',{archived:true}),row('h',{manageable:false})],[],['h']);
    const result=await archiveOrHide(['a','h'],false,d);
    expect(calls.engine).toEqual(['unarchive:a']);
    expect(calls.hide).toEqual([{ids:['h'],hidden:false}]);
    expect(result).toEqual({ok:true,notice:null,hidden:[]});
  });
  it('skips chats already archived when archiving',async()=>{
    const {calls,deps:d}=deps([row('a',{archived:true})]);
    await archiveOrHide(['a'],true,d);
    expect(calls.engine).toEqual([]);expect(calls.hide).toEqual([]);
  });
});
