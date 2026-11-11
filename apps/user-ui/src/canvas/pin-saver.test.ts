import {describe,expect,it,vi} from 'vitest';
import type {AgentPins} from '@nest/schemas';
import {createPinSaver} from './pin-saver';

/** A put whose answers the test releases by hand, in any order. */
function fakePut(){
  const calls:{list:string[];expectSaved?:false;resolve(pins:AgentPins):void;reject(error:unknown):void}[]=[];
  const put=(list:string[],expectSaved?:false)=>new Promise<AgentPins>((resolve,reject)=>{calls.push({list,expectSaved,resolve,reject});});
  return {put,calls};
}
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const conflict=new Error('409');

function saver(){
  const {put,calls}=fakePut();
  const events={saved:vi.fn(),error:vi.fn(),conflict:vi.fn()};
  const s=createPinSaver({put,isConflict:error=>error===conflict,onSaved:events.saved,onError:events.error,onConflict:events.conflict});
  return {s,calls,events};
}

describe('createPinSaver',()=>{
  it('keeps one PUT in flight and sends only the newest list after it, so the server ends on the last change',async()=>{
    const {s,calls,events}=saver();
    s.confirm({agentNames:['A'],saved:true});
    s.save(['A','B']);
    s.save(['A','B','C']);
    s.save(['A','C']);
    expect(calls.map(c=>c.list)).toEqual([['A','B']]);
    calls[0].resolve({agentNames:['A','B'],saved:true});
    await tick();
    // The middle list never goes out; the newest follows the first.
    expect(calls.map(c=>c.list)).toEqual([['A','B'],['A','C']]);
    expect(events.saved).not.toHaveBeenCalled();
    calls[1].resolve({agentNames:['A','C'],saved:true});
    await tick();
    expect(events.saved).toHaveBeenCalledExactlyOnceWith({agentNames:['A','C'],saved:true});
    expect(s.busy()).toBe(false);
  });

  it('sends expectSaved:false only while the server holds no list',async()=>{
    const {s,calls}=saver();
    s.save(['Seed','Plus']);
    s.save(['Seed']);
    expect(calls[0].expectSaved).toBe(false);
    calls[0].resolve({agentNames:['Seed','Plus'],saved:true});
    await tick();
    expect(calls[1].expectSaved).toBeUndefined();
  });

  it('drops the queue and reports a conflict when pins were saved elsewhere',async()=>{
    const {s,calls,events}=saver();
    s.save(['Seed']);
    s.save(['Seed','More']);
    calls[0].reject(conflict);
    await tick();
    expect(events.conflict).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(1);
  });

  it('reports a failure with the last confirmed list, unless a newer list is already on its way',async()=>{
    const {s,calls,events}=saver();
    s.confirm({agentNames:['A'],saved:true});
    s.save(['A','B']);
    s.save(['A','B','C']);
    calls[0].reject(new Error('down'));
    await tick();
    expect(events.error).not.toHaveBeenCalled();
    calls[1].reject(new Error('down'));
    await tick();
    expect(events.error).toHaveBeenCalledExactlyOnceWith({agentNames:['A'],saved:true});
  });
});
