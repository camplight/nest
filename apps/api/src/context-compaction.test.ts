import {describe,it,expect} from 'vitest';
import {planCompaction,shouldCompact,transcriptOf,type ChannelEvent} from './context-compaction';

const message=(n:number,text='x'.repeat(80),createdAt=n*10):ChannelEvent=>({id:`e${n}`,type:'message.created',source:n%2?'human:alex':'agent:Pip',createdAt,payload:{text}});

describe('when Nest compacts a chat',()=>{
  it('starts once the history reaches three quarters of the budget',()=>{
    expect(shouldCompact({historyChars:7_499,historyMaxChars:10_000})).toBe(false);
    expect(shouldCompact({historyChars:7_500,historyMaxChars:10_000})).toBe(true);
    expect(shouldCompact({historyChars:5,historyMaxChars:0})).toBe(false);
  });
  it('keeps recent messages word for word within half the budget and summarizes the rest',()=>{
    const events=Array.from({length:40},(_,n)=>message(n+1));
    const plan=planCompaction(events,{historyMaxChars:2_000})!;
    const keptChars=plan.kept.reduce((sum,event)=>sum+JSON.stringify({source:event.source,type:event.type,payload:event.payload}).length,0);
    expect(keptChars).toBeLessThanOrEqual(1_000);
    expect(plan.kept.at(-1)?.id).toBe('e40');
    expect([...plan.older,...plan.kept].map(e=>e.id)).toEqual(events.map(e=>e.id));
    expect(plan.cutoff).toBe(plan.older.at(-1));
    expect(plan.more).toBe(false);
  });
  it('ignores tool, telemetry, turn and context events, as the engine does',()=>{
    const noise:ChannelEvent[]=['tool.started','telemetry.context.window.updated','agent.turn.started','agent.context.compacted','audit.x','memory.x']
      .map((type,n)=>({id:`n${n}`,type,source:'agent:Pip',createdAt:5+n*10,payload:{text:'y'.repeat(5_000)}}));
    const plan=planCompaction([...noise,...Array.from({length:30},(_,n)=>message(n+1))],{historyMaxChars:2_000})!;
    expect([...plan.older,...plan.kept].every(e=>e.type==='message.created')).toBe(true);
  });
  it('never splits messages that share a timestamp across the cutoff',()=>{
    const events=Array.from({length:30},(_,n)=>message(n+1,'x'.repeat(80),n<20?100:200+n));
    const plan=planCompaction(events,{historyMaxChars:2_000})!;
    expect(plan.kept.some(e=>e.createdAt===plan.cutoff.createdAt)).toBe(false);
  });
  it('does nothing when there is too little older history',()=>{
    expect(planCompaction([message(1),message(2)],{historyMaxChars:2_000})).toBeNull();
    expect(planCompaction([message(1,'x'.repeat(3_000)),message(2,'x'.repeat(3_000))],{historyMaxChars:2_000})).toBeNull();
  });
  it('summarizes a very long backlog in steps, oldest first',()=>{
    const events=Array.from({length:400},(_,n)=>message(n+1,'x'.repeat(400)));
    const plan=planCompaction(events,{historyMaxChars:20_000})!;
    expect(plan.more).toBe(true);
    expect(plan.older[0]?.id).toBe('e1');
    expect(transcriptOf(plan.older).length).toBeLessThanOrEqual(20_000);
  });
  it('keeps nothing back from a page that the engine cut short',()=>{
    const events=Array.from({length:30},(_,n)=>message(n+1));
    const plan=planCompaction(events,{historyMaxChars:200_000,truncated:true})!;
    expect(plan.kept).toEqual([]);
    expect(plan.more).toBe(true);
  });
  it('shortens very long messages in the transcript',()=>{
    expect(transcriptOf([message(1,'z'.repeat(20_000))]).length).toBeLessThan(5_000);
  });
});
