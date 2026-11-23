import {describe,expect,it} from 'vitest';
import {SPLIT_DEFAULT,SPLIT_KEY,SPLIT_MAX,SPLIT_MIN,clampSplit,readSplit,splitAt,writeSplit} from './split';

const memory=(initial:Record<string,string>={})=>{
  const values=new Map(Object.entries(initial));
  return {getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);},values};
};

describe('canvas split screen',()=>{
  it('keeps at least 40% of the width for the canvas',()=>{
    expect(SPLIT_MAX).toBe(60);
    expect(clampSplit(90)).toBe(SPLIT_MAX);
    expect(clampSplit(5)).toBe(SPLIT_MIN);
    expect(clampSplit(47.26)).toBe(47.3);
    expect(clampSplit(Number.NaN)).toBe(SPLIT_DEFAULT);
  });

  it('reads the chat width from the divider position, measured from the right edge',()=>{
    expect(splitAt(600,{left:200,width:1000})).toBe(60);
    expect(splitAt(900,{left:200,width:1000})).toBe(30);
    expect(splitAt(100,{left:200,width:1000})).toBe(SPLIT_MAX);
    expect(splitAt(1300,{left:200,width:1000})).toBe(SPLIT_MIN);
    expect(splitAt(500,{left:0,width:0})).toBe(SPLIT_DEFAULT);
  });

  it('remembers the width in nest-canvas-split and ignores bad values',()=>{
    expect(SPLIT_KEY).toBe('nest-canvas-split');
    const storage=memory();
    expect(readSplit(storage)).toBe(SPLIT_DEFAULT);
    writeSplit(52.5,storage);
    expect(storage.values.get(SPLIT_KEY)).toBe('52.5');
    expect(readSplit(storage)).toBe(52.5);
    expect(readSplit(memory({[SPLIT_KEY]:'wide'}))).toBe(SPLIT_DEFAULT);
    expect(readSplit(memory({[SPLIT_KEY]:'95'}))).toBe(SPLIT_MAX);
    const throwing={getItem:()=>{throw Error('blocked');},setItem:()=>{throw Error('blocked');}};
    expect(readSplit(throwing)).toBe(SPLIT_DEFAULT);
    expect(()=>writeSplit(40,throwing)).not.toThrow();
  });
});
