// Quote-reply text helpers (spec 7.3, 7.4.5): the composer's blockquote, the stored excerpt and the selection check.
// selectionQuote reads only a narrow part of Selection, so it runs on plain objects in node tests as well as on the DOM.
type SelectionLike=Pick<Selection,'isCollapsed'|'rangeCount'|'toString'|'anchorNode'|'focusNode'>;
type NodeLike={nodeType:number;parentElement:Element|null};

const QUOTE_MAX=2000;
const EXCERPT_MAX=500;
const MESSAGE='[data-message-id]';
const NOT_QUOTABLE='[data-aui-quote-selectable="false"]';

// '> **author** wrote:\n> line1\n> line2\n\n', the text cut to 2000 characters.
export function quoteMarkdown(author:string,text:string):string{
 const lines=text.slice(0,QUOTE_MAX).replace(/\r\n?/g,'\n').split('\n');
 return `> **${author}** wrote:\n${lines.map(line=>line?`> ${line}`:'>').join('\n')}\n\n`;
}
// At most 500 characters, a cut text keeping 499 and a trailing ellipsis.
export function replyExcerpt(text:string):string{
 return text.length<=EXCERPT_MAX?text:text.slice(0,EXCERPT_MAX-1)+'…';
}
const elementOf=(node:Node|null):Element|null=>{
 const like=node as NodeLike|null;
 return !like?null:like.nodeType===1?like as unknown as Element:like.parentElement;
};
// The selected text when it lies inside one message of `root` and touches no non-quotable region, else null.
export function selectionQuote(selection:SelectionLike|null,root:Element):{eventId:string;text:string}|null{
 if(!selection||selection.isCollapsed||selection.rangeCount===0)return null;
 const text=selection.toString().trim();
 if(!text)return null;
 const anchor=elementOf(selection.anchorNode),focus=elementOf(selection.focusNode);
 if(!anchor||!focus)return null;
 const message=anchor.closest(MESSAGE);
 if(!message||message!==focus.closest(MESSAGE)||!root.contains(message))return null;
 if(anchor.closest(NOT_QUOTABLE)||focus.closest(NOT_QUOTABLE))return null;
 const eventId=message.getAttribute('data-message-id');
 return eventId?{eventId,text}:null;
}
