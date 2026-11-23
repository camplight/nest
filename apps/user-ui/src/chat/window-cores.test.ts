import {describe,expect,it} from 'vitest';
import {createWindowCores} from './window-cores';
import type {ChannelEventsCore} from './channel-events';
import type {EventRow} from '../types';

function fake(){
  const calls:string[]=[];
  const core={
    switchTo:async(id:string|null)=>{calls.push(`switchTo:${id}`)},
    refresh:async()=>{calls.push('refresh')},
    ingest:(e:EventRow)=>{calls.push(`ingest:${e.id}`)},
    observeLifecycle:(e:EventRow)=>{calls.push(`observe:${e.id}`)},
  };
  return {core:core as unknown as ChannelEventsCore,calls};
}
function setup(){
  const made:ReturnType<typeof fake>[]=[];
  const cores=createWindowCores(()=>{const f=fake();made.push(f);return f.core;});
  return {cores,made};
}
const ev=(id:string,channelId?:string)=>({id,channelId} as unknown as EventRow);

describe('createWindowCores',()=>{
  it('acquire twice shares one core and switches it once',()=>{
    const {cores,made}=setup();
    expect(cores.acquire('c1')).toBe(cores.acquire('c1'));
    expect(made).toHaveLength(1);
    expect(made[0].calls).toEqual(['switchTo:c1']);
  });
  it('release twice drops it',()=>{
    const {cores,made}=setup();
    const first=cores.acquire('c1');cores.acquire('c1');
    cores.release('c1');
    expect(cores.acquire('c1')).toBe(first);
    cores.release('c1');cores.release('c1');
    expect(cores.acquire('c1')).not.toBe(first);
    expect(made).toHaveLength(2);
  });
  it('ingest routes by channel',()=>{
    const {cores,made}=setup();
    cores.acquire('c1');cores.acquire('c2');
    cores.ingest(ev('e1','c1'));
    expect(made[0].calls).toEqual(['switchTo:c1','observe:e1','ingest:e1']);
    expect(made[1].calls).toEqual(['switchTo:c2']);
    cores.ingest(ev('e2'));cores.ingest(ev('e3','c9'));
    expect(made[0].calls).toHaveLength(3);
    expect(made[1].calls).toHaveLength(1);
  });
  it('ingest forwards a repeated event id',()=>{
    const {cores,made}=setup();
    cores.acquire('c1');
    cores.ingest(ev('e1','c1'));cores.ingest(ev('e1','c1'));
    expect(made[0].calls.filter(c=>c==='ingest:e1')).toHaveLength(2);
  });
  it('refreshAll refreshes every held core',()=>{
    const {cores,made}=setup();
    cores.acquire('c1');cores.acquire('c2');
    cores.refreshAll();
    expect(made.map(m=>m.calls.filter(c=>c==='refresh').length)).toEqual([1,1]);
  });
});
