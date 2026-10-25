import {describe,expect,it} from 'vitest';
import {quoteMarkdown,replyExcerpt,selectionQuote} from './quote';

// No DOM library here: plain-object elements that answer closest, getAttribute and contains, and text nodes under them.
type FakeElement={nodeType:1;parentElement:FakeElement|null;attrs:Record<string,string>;
 getAttribute(name:string):string|null;closest(selector:string):FakeElement|null;contains(node:unknown):boolean};
const matches=(el:FakeElement,selector:string)=>{
 const match=/^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(selector);
 if(!match)throw new Error(`unsupported selector ${selector}`);
 const value=el.attrs[match[1]!];
 return value!==undefined&&(match[2]===undefined||value===match[2]);
};
function element(parent:FakeElement|null,attrs:Record<string,string>={}):FakeElement{
 const el:FakeElement={nodeType:1,parentElement:parent,attrs,
  getAttribute:name=>attrs[name]??null,
  closest(selector){for(let node:FakeElement|null=el;node;node=node.parentElement)if(matches(node,selector))return node;return null;},
  contains(node){for(let at=node as {parentElement?:FakeElement|null}|null;at;at=at.parentElement??null)if(at===el)return true;return false;}};
 return el;
}
const text=(parent:FakeElement)=>({nodeType:3,parentElement:parent});
const selection=(anchorNode:unknown,focusNode:unknown,value:string,isCollapsed=false)=>
 ({isCollapsed,rangeCount:isCollapsed?0:1,toString:()=>value,anchorNode,focusNode}) as unknown as Selection;

const root=element(null);
const first=element(root,{'data-message-id':'event-1'}),second=element(root,{'data-message-id':'event-2'});
const firstBody=element(first),secondBody=element(second);
const excluded=element(first,{'data-aui-quote-selectable':'false'});

describe('quoteMarkdown',()=>{
 it('prefixes every line and ends with a blank line',()=>{
  expect(quoteMarkdown('Pip','a\nb')).toBe('> **Pip** wrote:\n> a\n> b\n\n');
 });
});

describe('replyExcerpt',()=>{
 it('cuts a long text to 500 characters ending in an ellipsis',()=>{
  const excerpt=replyExcerpt('x'.repeat(600));
  expect(excerpt).toHaveLength(500);
  expect(excerpt.endsWith('…')).toBe(true);
 });
 it('keeps a short text',()=>{
  expect(replyExcerpt('0123456789')).toBe('0123456789');
 });
});

describe('selectionQuote',()=>{
 it('returns null for a collapsed selection',()=>{
  const node=text(firstBody);
  expect(selectionQuote(selection(node,node,'',true),root as unknown as Element)).toBeNull();
 });
 it('returns null for a selection across two messages',()=>{
  expect(selectionQuote(selection(text(firstBody),text(secondBody),'Synthetic across'),root as unknown as Element)).toBeNull();
 });
 it('returns null inside a non-quotable region',()=>{
  const node=text(excluded);
  expect(selectionQuote(selection(node,node,'Synthetic activity'),root as unknown as Element)).toBeNull();
 });
 it('returns the message id and the selected text inside one message',()=>{
  expect(selectionQuote(selection(text(firstBody),text(firstBody),' Synthetic part '),root as unknown as Element)).toEqual({eventId:'event-1',text:'Synthetic part'});
 });
});
