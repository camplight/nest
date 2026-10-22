import {useEffect,useId,useRef,useState,type KeyboardEvent,type RefObject} from 'react';
import {motion,useReducedMotion} from 'motion/react';
import {AgentAvatar} from './AgentAvatar';
import {findMention,insertMention,rankMentions,type MentionCandidate} from '../mentions';
import './mentions.css';

export function useMentionPicker({value,onChange,onChoose,onAskAssistant,onInvite,textareaRef,candidates,channelId,disabled,targeted=false,projectDraft=false}:{value:string;onChange:(value:string)=>void;onChoose?:(value:string,mention:import('@nest/schemas').SelectedMention)=>void;onAskAssistant?:(name:string,brief:string)=>void;onInvite?:(candidate:MentionCandidate)=>Promise<void>;targeted?:boolean;projectDraft?:boolean;textareaRef:RefObject<HTMLTextAreaElement>;candidates:MentionCandidate[];channelId:string|null;disabled:boolean}) {
  const id=useId();
  const reduced=useReducedMotion();
  const [selection,setSelection]=useState({start:0,end:0});
  const [focused,setFocused]=useState(false);
  const [composing,setComposing]=useState(false);
  const [dismissed,setDismissed]=useState('');
  const [highlight,setHighlight]=useState(0);
  const [inviting,setInviting]=useState<string|null>(null),[inviteError,setInviteError]=useState<string|null>(null);
  const pending=useRef<{cancelled:boolean}|null>(null);
  const latest=useRef({value,channelId,disabled});latest.current={value,channelId,disabled};
  useEffect(()=>{setInviting(null);setInviteError(null);return()=>{pending.current=null;};},[channelId]);
  const listRef=useRef<HTMLDivElement>(null);
  const stamp=`${channelId}:${value}:${selection.start}:${selection.end}`;
  const query=focused && !disabled && !composing && dismissed!==stamp ? findMention(value,selection.start,selection.end) : null;
  const results=query ? rankMentions(candidates,query.query) : [];
  const shown=results.slice(0,8);
  const index=Math.min(highlight,Math.max(0,shown.length-1));
  const open=Boolean(query);
  useEffect(()=>{setHighlight(0);},[query?.query,query?.start,channelId]);
  useEffect(()=>{listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({block:'nearest'});},[index,query?.query]);
  useEffect(()=>{
    const node=textareaRef.current;
    setFocused(Boolean(node && document.activeElement===node));
    if(node)setSelection({start:node.selectionStart,end:node.selectionEnd});
  },[channelId,textareaRef]);
  const sync=(node:HTMLTextAreaElement)=>setSelection({start:node.selectionStart,end:node.selectionEnd});
  async function choose(candidate:MentionCandidate) {
    if(!query||pending.current||disabled)return;
    if(candidate.assistantOwner && onAskAssistant && !onInvite){
      setDismissed(stamp);onAskAssistant(candidate.name,(value.slice(0,query.start)+value.slice(query.end)).trim());return;
    }
    if(targeted&&!candidate.inConversation){
      if(!onInvite||candidate.inviteBlockedReason)return;
      const operation={cancelled:false};pending.current=operation;setInviting(candidate.name);setInviteError(null);
      try{await onInvite(candidate);if(pending.current!==operation)return;}catch{
        if(pending.current===operation)setInviteError(`Couldn’t confirm ${candidate.name} was added. Your draft is unchanged. Select again to retry.`);
        return;
      }finally{if(pending.current===operation){setInviting(null);pending.current=null;}}
      if(operation.cancelled||latest.current.channelId!==channelId||latest.current.value!==value||latest.current.disabled)return;
    }
    const inserted=insertMention(value,query,candidate.name);
    if(onChoose)onChoose(inserted.value,{kind:candidate.kind==='Agent'?'AGENT':'HUMAN',name:candidate.name,start:query.start,end:query.start+candidate.name.length+1});else onChange(inserted.value);
    setDismissed(`${channelId}:${inserted.value}:${inserted.caret}:${inserted.caret}`);
    window.requestAnimationFrame(()=>{
      const node=textareaRef.current;if(!node||node.value!==inserted.value)return;
      node.focus();node.setSelectionRange(inserted.caret,inserted.caret);sync(node);
    });
  }
  function onKeyDown(event:KeyboardEvent<HTMLTextAreaElement>) {
    if(!open || event.nativeEvent.isComposing || event.keyCode===229 || event.ctrlKey || event.metaKey || event.altKey)return false;
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(pending.current)pending.current.cancelled=true;setDismissed(stamp);return true;}
    if(inviting&&(event.key==='Enter'||event.key==='Tab')){event.preventDefault();return true;}
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){
      event.preventDefault();setHighlight(shown.length ? (index+(event.key==='ArrowDown'?1:-1)+shown.length)%shown.length : 0);return true;
    }
    if((event.key==='Enter'||event.key==='Tab')&&!event.shiftKey){
      if(shown[index]){event.preventDefault();void choose(shown[index]);return true;}
      if(event.key==='Enter'){event.preventDefault();return true;}
    }
    return false;
  }
  const textareaProps={
    readOnly:Boolean(inviting),
    'aria-busy':Boolean(inviting),
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
      {shown.map((candidate,i)=><div key={candidate.id} id={`${id}-${i}`} role="option" aria-disabled={Boolean(inviting)||(targeted&&!candidate.inConversation&&!candidate.assistantOwner&&(!onInvite||Boolean(candidate.inviteBlockedReason)))} aria-selected={i===index} className="mention-option"
        onPointerDown={event=>event.preventDefault()} onPointerMove={()=>setHighlight(i)} onClick={()=>{void choose(candidate);}}>
        {candidate.kind==='Agent' ? <AgentAvatar name={candidate.name} size={34}/> : <span className="mention-person" aria-hidden="true">{candidate.name.slice(0,2).toUpperCase()}</span>}
        <span className="mention-identity"><strong>{candidate.name}</strong><small>{candidate.assistantOwner?`Personal agent of ${candidate.assistantOwner} · ${onInvite?'Add to chat and mention':'Open conversation'}`:<>{candidate.kind} · {candidate.inConversation?(targeted?(candidate.kind==='Agent'?'Direct request':'Notify person'):'In this chat'):(projectDraft?'Add to this project':targeted?(candidate.inviteBlockedReason??(onInvite?'Add to chat and mention':'Ask a chat manager to add them')):'Not in this chat')}</>}</small></span>
        <span className="mention-at" aria-hidden="true">@</span>
      </div>)}
    </div>
    {inviting&&<p className="mention-empty" role="status">Adding {inviting}…</p>}
    {inviteError&&<p className="mention-empty" role="alert">{inviteError}</p>}
    {!shown.length && <p className="mention-empty" role="status">No matches. Try another name.</p>}
    <div id={`${id}-help`} className="mention-help">↑↓ to browse · Enter or Tab to select · Esc to close<br/>{projectDraft?'Selected people and agents join when you send your first message.':targeted?(onInvite?'New teammates can read this chat’s history and files. Agents keep their owner-granted tools.':'Choose a chat recipient, or open a conversation with a personal agent.'):'Mentioning someone does not add them to this chat.'}</div>
  </motion.div> : null;
  return {popup,textareaProps,onKeyDown,sync,inviting};
}
