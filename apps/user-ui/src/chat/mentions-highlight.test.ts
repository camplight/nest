import {describe,expect,it} from 'vitest';
import type {Root} from 'hast';
import {mentionNames,rehypeMentions,splitMentions} from './mentions-highlight';

describe('splitMentions',()=>{
 it('marks each @name as a whole word',()=>{
  expect(splitMentions('@Sable - what is your specialty, @Sable?',['Sable'])).toEqual([{mention:'Sable'},' - what is your specialty, ',{mention:'Sable'},'?']);
 });
 it('ignores emails, longer names and names it was not given',()=>{
  expect(splitMentions('mail sable@x.io, @Sabless and @Moss',['Sable'])).toEqual(['mail sable@x.io, @Sabless and @Moss']);
 });
 it('prefers the longest name and keeps names with spaces',()=>{
  expect(splitMentions('Ask @Research & Design now',['Research','Research & Design'])).toEqual(['Ask ',{mention:'Research & Design'},' now']);
 });
 it('returns the text unchanged without names',()=>{
  expect(splitMentions('@Sable hi',[])).toEqual(['@Sable hi']);
 });
});

describe('mentionNames',()=>{
 it('takes the selected mentions and the agents a message was sent to, once each',()=>{
  expect(mentionNames({mentions:[{kind:'AGENT',name:'Sable',start:0,end:6},{kind:'HUMAN',name:'demo-bob',start:9,end:18}]},['Sable','Wren'])).toEqual(['Sable','demo-bob','Wren']);
 });
 it('tolerates payloads without mentions',()=>{
  expect(mentionNames(undefined,[])).toEqual([]);
  expect(mentionNames({mentions:'broken'},['Wren'])).toEqual(['Wren']);
 });
});

describe('rehypeMentions',()=>{
 it('wraps mentions in text but never inside code or links',()=>{
  const tree:Root={type:'root',children:[
   {type:'element',tagName:'p',properties:{},children:[{type:'text',value:'Hi @Wren, see '},{type:'element',tagName:'code',properties:{},children:[{type:'text',value:'@Wren'}]},{type:'element',tagName:'a',properties:{href:'#'},children:[{type:'text',value:'@Wren'}]}]},
  ]};
  rehypeMentions(['Wren'])(tree);
  const p=tree.children[0] as any;
  expect(p.children[0]).toEqual({type:'text',value:'Hi '});
  expect(p.children[1]).toEqual({type:'element',tagName:'span',properties:{className:['chat-mention']},children:[{type:'text',value:'@Wren'}]});
  expect(p.children[2]).toEqual({type:'text',value:', see '});
  expect(p.children[3].children[0]).toEqual({type:'text',value:'@Wren'});
  expect(p.children[4].children[0]).toEqual({type:'text',value:'@Wren'});
 });
});
