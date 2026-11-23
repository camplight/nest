// Highlights who a message mentions (spec 6.5): the people and agents picked from the @ list, stored with the message,
// and the agents it was addressed to. Only those names, as whole words; other @ text, code and links stay as written.
import type {Element,ElementContent,Root} from 'hast';

export type MentionPart=string|{mention:string};
const escape=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

/** Splits text around `@name` for the given names; the longest name wins, and a name must end at a word boundary. */
export function splitMentions(text:string,names:readonly string[]):MentionPart[]{
 const unique=[...new Set(names.filter(Boolean))].sort((a,b)=>b.length-a.length);
 if(!unique.length)return [text];
 const pattern=new RegExp(`(?<![\\w.@])@(${unique.map(escape).join('|')})(?![\\w@-])`,'gu');
 const parts:MentionPart[]=[];
 let last=0;
 for(const match of text.matchAll(pattern)){
  if(match.index>last)parts.push(text.slice(last,match.index));
  parts.push({mention:match[1]!});last=match.index+match[0].length;
 }
 if(last<text.length)parts.push(text.slice(last));
 return parts.length?parts:[text];
}

/** The names to highlight: selected mentions from the message payload, then the agents it targeted. */
export function mentionNames(payload:unknown,targetAgents:readonly string[]):string[]{
 const mentions=payload&&typeof payload==='object'?(payload as {mentions?:unknown}).mentions:undefined;
 const selected=Array.isArray(mentions)?mentions.flatMap(item=>item&&typeof item==='object'&&typeof (item as {name?:unknown}).name==='string'?[(item as {name:string}).name]:[]):[];
 return [...new Set([...selected,...targetAgents])];
}

const SKIP=new Set(['code','pre','a']);
const mentionElement=(name:string):Element=>({type:'element',tagName:'span',properties:{className:['chat-mention']},children:[{type:'text',value:'@'+name}]});

/** A rehype plugin for MarkdownText: wraps mentions in text nodes, leaving code, code blocks and links alone. */
export function rehypeMentions(names:readonly string[]){
 return (tree:Root)=>{
  if(!names.length)return;
  const visit=(node:Root|Element)=>{
   const next:ElementContent[]=[];
   for(const child of node.children as ElementContent[]){
    if(child.type==='text'){
     for(const part of splitMentions(child.value,names))next.push(typeof part==='string'?{type:'text',value:part}:mentionElement(part.mention));
    }else{
     if(child.type==='element'&&!SKIP.has(child.tagName))visit(child);
     next.push(child);
    }
   }
   node.children=next as typeof node.children;
  };
  visit(tree);
 };
}
