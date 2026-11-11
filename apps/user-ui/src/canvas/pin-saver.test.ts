import {describe,expect,it,vi} from 'vitest';
import type {AgentPins} from '@nest/schemas';
import {createPinPresses,createPinSaver} from './pin-saver';

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

describe('createPinSaver dispose',()=>{
  it('drops pending saves and ignores an answer still on its way, so a list is never saved under the next person',async()=>{
    const {s,calls,events}=saver();
    s.save(['A']);
    s.save(['A','B']);
    s.dispose();
    calls[0].resolve({agentNames:['A'],saved:true});
    await tick();
    expect(calls).toHaveLength(1);
    expect(events.saved).not.toHaveBeenCalled();
    s.save(['C']);
    expect(calls).toHaveLength(1);
  });

  it('ignores a failure that lands after dispose',async()=>{
    const {s,calls,events}=saver();
    s.save(['A']);
    s.dispose();
    calls[0].reject(new Error('down'));
    await tick();
    expect(events.error).not.toHaveBeenCalled();
  });
});

describe('createPinPresses',()=>{
  type State={agentNames:string[];saved:boolean;failed?:true};
  function presses(initial:State|null,reloads:(()=>Promise<State>)[]){
    let state=initial;
    const applied:string[][]=[],failures=vi.fn();
    const p=createPinPresses<State>({
      current:()=>state,
      reload:()=>reloads.shift()!().then(next=>{state=next;return next;}),
      apply:(name,from)=>{const next=from.agentNames.includes(name)?from.agentNames.filter(n=>n!==name):[...from.agentNames,name];state={agentNames:next,saved:true};applied.push(next);},
      onLoadFailed:failures,
    });
    return {p,applied,failures,get:()=>state};
  }
  const failed:State={agentNames:[],saved:false,failed:true};

  it('queues a second press behind the retry and applies both to the list the retry read',async()=>{
    const {p,applied,get}=presses(failed,[async()=>({agentNames:['Saved'],saved:true})]);
    p.press('A');
    await p.press('B');
    expect(applied).toEqual([['Saved','A'],['Saved','A','B']]);
    expect(get()).toEqual({agentNames:['Saved','A','B'],saved:true});
  });

  it('says the read failed and saves nothing when the retry fails, then the next press retries again',async()=>{
    const {p,applied,failures}=presses(failed,[async()=>{throw new Error('down');},async()=>({agentNames:[],saved:true})]);
    await p.press('A');
    expect(failures).toHaveBeenCalledOnce();
    expect(applied).toEqual([]);
    await p.press('B');
    expect(applied).toEqual([['B']]);
  });

  it('ignores presses while loading and after dispose, including one waiting on a retry',async()=>{
    const loading=presses(null,[]);
    await loading.p.press('A');
    expect(loading.applied).toEqual([]);
    let release!:(s:State)=>void;
    const {p,applied,failures}=presses(failed,[()=>new Promise<State>(resolve=>{release=resolve;})]);
    const pending=p.press('A');
    await tick();
    p.dispose();
    release({agentNames:[],saved:true});
    await pending;
    expect(applied).toEqual([]);
    expect(failures).not.toHaveBeenCalled();
  });
});
