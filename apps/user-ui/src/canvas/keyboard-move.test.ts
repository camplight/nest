import {describe,expect,it,vi} from 'vitest';
import {createMoveBurst,moveAnnouncement,nudge,pressArmsMove} from './keyboard-move';

/** A timer the test fires by hand: only the newest pending callback is kept, as clearTimer drops the older one. */
function fakeTimer(){
  let next=1;
  const pending=new Map<number,{fn:()=>void;ms:number}>();
  return {
    setTimer:(fn:()=>void,ms:number)=>{const id=next++;pending.set(id,{fn,ms});return id;},
    clearTimer:(id:unknown)=>{pending.delete(id as number);},
    fire(){const due=[...pending.values()];pending.clear();for(const t of due)t.fn();},
    pending,
  };
}

describe('nudge',()=>{
  it('moves 8 world px per arrow press, 40 with Shift',()=>{
    expect(nudge('ArrowLeft',false)).toEqual({dx:-8,dy:0});
    expect(nudge('ArrowRight',false)).toEqual({dx:8,dy:0});
    expect(nudge('ArrowUp',false)).toEqual({dx:0,dy:-8});
    expect(nudge('ArrowDown',false)).toEqual({dx:0,dy:8});
    expect(nudge('ArrowLeft',true)).toEqual({dx:-40,dy:0});
    expect(nudge('ArrowRight',true)).toEqual({dx:40,dy:0});
    expect(nudge('ArrowUp',true)).toEqual({dx:0,dy:-40});
    expect(nudge('ArrowDown',true)).toEqual({dx:0,dy:40});
  });
  it('ignores every other key',()=>{
    expect(nudge('a',false)).toBeNull();
    expect(nudge('Tab',false)).toBeNull();
    expect(nudge('Tab',true)).toBeNull();
    expect(nudge('Enter',false)).toBeNull();
    expect(nudge(' ',false)).toBeNull();
  });
});

describe('createMoveBurst',()=>{
  it('sums presses within the idle delay into one commit',()=>{
    const timer=fakeTimer(),commit=vi.fn(),revert=vi.fn();
    const burst=createMoveBurst({commit,revert,setTimer:timer.setTimer,clearTimer:timer.clearTimer});
    expect(burst.step(8,0)).toEqual({dx:8,dy:0});
    expect(burst.step(8,0)).toEqual({dx:16,dy:0});
    expect(burst.step(0,-40)).toEqual({dx:16,dy:-40});
    // Each press restarts the wait: one timer, at the default 400 ms.
    expect([...timer.pending.values()].map(t=>t.ms)).toEqual([400]);
    expect(commit).not.toHaveBeenCalled();
    timer.fire();
    expect(commit).toHaveBeenCalledExactlyOnceWith(16,-40);
    expect(revert).not.toHaveBeenCalled();
    expect(burst.active()).toBe(false);
  });
  it('reverts on cancel and never commits',()=>{
    const timer=fakeTimer(),commit=vi.fn(),revert=vi.fn();
    const burst=createMoveBurst({commit,revert,delayMs:250,setTimer:timer.setTimer,clearTimer:timer.clearTimer});
    burst.step(8,0); burst.step(0,8);
    expect([...timer.pending.values()].map(t=>t.ms)).toEqual([250]);
    burst.cancel();
    expect(revert).toHaveBeenCalledOnce();
    expect(timer.pending.size).toBe(0);
    timer.fire();
    expect(commit).not.toHaveBeenCalled();
    // A cancel with nothing pending does nothing.
    burst.cancel();
    expect(revert).toHaveBeenCalledOnce();
  });
  it('commits at once on flush, and a burst that nets to zero commits nothing',()=>{
    const timer=fakeTimer(),commit=vi.fn(),revert=vi.fn();
    const burst=createMoveBurst({commit,revert,setTimer:timer.setTimer,clearTimer:timer.clearTimer});
    burst.step(40,0);
    burst.flush();
    expect(commit).toHaveBeenCalledExactlyOnceWith(40,0);
    expect(timer.pending.size).toBe(0);
    burst.step(8,0); burst.step(-8,0);
    timer.fire();
    expect(commit).toHaveBeenCalledOnce();
    // Nothing moved, so the preview is put back.
    expect(revert).toHaveBeenCalledOnce();
  });
});

describe('moveAnnouncement',()=>{
  const research={id:'a1',title:'Research'};
  it('names the area a card moved into, or out of',()=>{
    expect(moveAnnouncement(null,research)).toBe('Moved into Research');
    expect(moveAnnouncement({id:'a2',title:'Inbox'},research)).toBe('Moved into Research');
    // Another area that happens to share the title is still a different area.
    expect(moveAnnouncement({id:'a3',title:'Research'},research)).toBe('Moved into Research');
    expect(moveAnnouncement(research,null)).toBe('Moved out of Research');
    expect(moveAnnouncement(null,{id:'a4',title:''})).toBe('Moved into Untitled area');
  });
  it('says Moved when the area did not change',()=>{
    expect(moveAnnouncement(research,{...research})).toBe('Moved');
    expect(moveAnnouncement(null,null)).toBe('Moved');
  });
});

describe('pressArmsMove',()=>{
  /** A pressed element whose nearest focusable ancestor (what a press would focus) carries `classes`, or none. */
  const pressOn=(classes:string[]|null)=>({closest:(selector:string)=>{
    expect(selector).toContain('[tabindex]');
    return classes?{matches:(s:string)=>s.split(',').some(part=>classes.includes(part.trim().slice(1)))}:null;
  }});
  it('is true when a press would focus an editor\'s card or area itself',()=>{
    expect(pressArmsMove(pressOn(['canvas-card']))).toBe(true);
    expect(pressArmsMove(pressOn(['canvas-area']))).toBe(true);
  });
  it('is false for a control inside them, the surface, or nothing focusable',()=>{
    expect(pressArmsMove(pressOn(['canvas-card-open']))).toBe(false);
    expect(pressArmsMove(pressOn(['canvas-area-input']))).toBe(false);
    expect(pressArmsMove(pressOn(['canvas-surface']))).toBe(false);
    expect(pressArmsMove(pressOn(null))).toBe(false);
    expect(pressArmsMove(null)).toBe(false);
  });
});
