import {describe,expect,it} from 'vitest';
import {chatTakesEscape} from './LooseDrawer';

const body={};
const inWindow={};
const onCanvas={};
const chat=(windowed:boolean)=>({matches:(selector:string)=>windowed&&selector==='[data-window="true"]',contains:(node:unknown)=>node===inWindow});

describe('chatTakesEscape',()=>{
  it('leaves Escape to the drawer with no chat open',()=>{
    expect(chatTakesEscape(null,onCanvas,body)).toBe(false);
  });
  it('gives a phone chat every Escape',()=>{
    expect(chatTakesEscape(chat(false),onCanvas,body)).toBe(true);
  });
  it('gives a window Escape only with focus in it, on the body or nowhere, as the window closes by',()=>{
    expect(chatTakesEscape(chat(true),inWindow,body)).toBe(true);
    expect(chatTakesEscape(chat(true),body,body)).toBe(true);
    expect(chatTakesEscape(chat(true),null,body)).toBe(true);
    expect(chatTakesEscape(chat(true),onCanvas,body)).toBe(false);
  });
});
