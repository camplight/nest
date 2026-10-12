import {useEffect,useId,useRef,useState,type KeyboardEvent,type RefObject} from 'react';
import {motion,useReducedMotion} from 'motion/react';
import {AgentAvatar} from './AgentAvatar';
import {findMention,insertMention,rankMentions,type MentionCandidate} from '../mentions';
import './mentions.css';

export function useMentionPicker({value,onChange,textareaRef,candidates,channelId,disabled}:{value:string;onChange:(value:string)=>void;textareaRef:RefObject<HTMLTextAreaElement>;candidates:MentionCandidate[];channelId:string|null;disabled:boolean}) {
  const id=useId();
  const reduced=useReducedMotion();
  const [selection,setSelection]=useState({start:0,end:0});
  const [focused,setFocused]=useState(false);
  const [composing,setComposing]=useState(false);
  const [dismissed,setDismissed]=useState('');
  const [highlight,setHighlight]=useState(0);
  const listRef=useRef<HTMLDivElement>(null);
  const stamp=`${channelId}:${value}:${selection.start}:${selection.end}`;
  const query=focused && !disabled && !composing && dismissed!==stamp ? findMention(value,selection.start,selection.end) : null;
  const results=query ? rankMentions(candidates,query.query) : [];
  const shown=results.slice(0,8);
  const index=Math.min(highlight,Math.max(0,shown.length-1));
  const open=Boolean(query);
  useEffect(()=>{setHighlight(0);},[query?.query,query?.start,channelId]);
  useEffect(()=>{listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({block:'nearest'});},[index,query?.query]);
  useEffect(()=>{setFocused(false);},[channelId]);
  const sync=(node:HTMLTextAreaElement)=>setSelection({start:node.selectionStart,end:node.selectionEnd});
  function choose(candidate:MentionCandidate) {
    if(!query)return;
    const inserted=insertMention(value,query,candidate.name);
    onChange(inserted.value);
    setDismissed(`${channelId}:${inserted.value}:${inserted.caret}:${inserted.caret}`);
    window.requestAnimationFrame(()=>{
      const node=textareaRef.current;if(!node)return;
      node.focus();node.setSelectionRange(inserted.caret,inserted.caret);sync(node);
    });
  }
  function onKeyDown(event:KeyboardEvent<HTMLTextAreaElement>) {
    if(!open || event.nativeEvent.isComposing || event.keyCode===229 || event.ctrlKey || event.metaKey || event.altKey)return false;
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setDismissed(stamp);return true;}
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){
      event.preventDefault();setHighlight(shown.length ? (index+(event.key==='ArrowDown'?1:-1)+shown.length)%shown.length : 0);return true;
    }
    if((event.key==='Enter'||event.key==='Tab')&&!event.shiftKey){
      if(shown[index]){event.preventDefault();choose(shown[index]);return true;}
      if(event.key==='Enter'){event.preventDefault();return true;}
    }
    return false;
  }
  const textareaProps={
    'aria-autocomplete':'list' as const,
    'aria-controls':open ? id : undefined,
    'aria-activedescendant':open && shown[index] ? `${id}-${index}` : undefined,
    'aria-describedby':open ? `${id}-help` : undefined,
    onFocus:(event:React.FocusEvent<HTMLTextAreaElement>)=>{setFocused(true);sync(event.currentTarget);},
    onBlur:()=>setFocused(false),
    onSelect:(event:React.SyntheticEvent<HTMLTextAreaElement>)=>sync(event.currentTarget),
    onCompositionStart:()=>setComposing(true),
    onCompositionEnd:(event:React.CompositionEvent<HTMLTextAreaElement>)=>{setComposing(false);sync(event.currentTarget);},
  };
  const popup=open ? <motion.div className="mention-popup" initial={reduced ? false : {opacity:0,y:4}} animate={{opacity:1,y:0}} transition={{duration:reduced?0:0.12}}>
    <div className="mention-heading">Mention someone <span>{results.length} {results.length===1?'match':'matches'}</span></div>
    <div ref={listRef} id={id} role="listbox" aria-label="Mention people and agents" className="mention-options">
      {shown.map((candidate,i)=><div key={candidate.id} id={`${id}-${i}`} role="option" aria-selected={i===index} className="mention-option"
        onPointerDown={event=>event.preventDefault()} onPointerMove={()=>setHighlight(i)} onClick={()=>choose(candidate)}>
        {candidate.kind==='Agent' ? <AgentAvatar name={candidate.name} size={34}/> : <span className="mention-person" aria-hidden="true">{candidate.name.slice(0,2).toUpperCase()}</span>}
        <span className="mention-identity"><strong>{candidate.name}</strong><small>{candidate.kind} · {candidate.inConversation?'In this chat':'Not in this chat'}</small></span>
        <span className="mention-at" aria-hidden="true">@</span>
      </div>)}
    </div>
    {!shown.length && <p className="mention-empty" role="status">No matches. Try another name.</p>}
    <div id={`${id}-help`} className="mention-help">↑↓ to browse · Enter or Tab to select · Esc to close<br/>Mentioning someone does not add them to this chat.</div>
  </motion.div> : null;
  return {popup,textareaProps,onKeyDown,sync};
}
