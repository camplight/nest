import {describe,expect,it} from 'vitest';
import {summaryParts} from './area-summary';

const text=(parts:ReturnType<typeof summaryParts>)=>parts.map(p=>p.text).join(' · ');

describe('summaryParts',()=>{
  it('leaves out zero parts and marks the need count',()=>{
    expect(summaryParts({needYou:2,moving:3,quiet:1,chats:6},false)).toEqual([{text:'2 need you',need:true},{text:'3 moving'},{text:'1 quiet'}]);
    expect(text(summaryParts({needYou:0,moving:3,quiet:0,chats:3},false))).toBe('3 moving');
    expect(text(summaryParts({needYou:1,moving:0,quiet:2,chats:3},false))).toBe('1 need you · 2 quiet');
  });
  it('reads all quiet when nothing needs you, moves or has gone quiet',()=>{
    expect(summaryParts({needYou:0,moving:0,quiet:0,chats:4},false)).toEqual([{text:'all quiet'}]);
    expect(summaryParts({needYou:0,moving:0,quiet:0,chats:0},false)).toEqual([{text:'all quiet'}]);
  });
  it('an area with no chats whose context others use reads Shared resources',()=>{
    expect(summaryParts({needYou:0,moving:0,quiet:0,chats:0},true)).toEqual([{text:'Shared resources'}]);
    expect(text(summaryParts({needYou:0,moving:1,quiet:0,chats:1},true))).toBe('1 moving');
  });
});
