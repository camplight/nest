import {useEffect,useId,useRef,useState,type KeyboardEvent} from 'react';
import type {ProjectMember,ProjectMemberOption} from '@nest/schemas';
import {apiJson} from '../api';
import {rankMentions} from '../mentions';
import {AgentAvatar} from './AgentAvatar';
import {DesignIcon} from '../Dashboard';

const key=(member:ProjectMember)=>`${member.subscriberType}:${member.subscriberId}`;
function Avatar({member,size=32}:{member:ProjectMember;size?:number}) {
  return member.subscriberType==='AGENT'?<AgentAvatar name={member.subscriberId} size={size}/>:<span className="project-person-avatar" aria-hidden="true" style={{width:size,height:size}}>{member.subscriberId.slice(0,2).toUpperCase()}</span>;
}

export function ProjectMemberPicker({members,onChange,disabled}:{members:ProjectMember[];onChange:(members:ProjectMember[])=>void;disabled:boolean}) {
  const id=useId();
  const inputRef=useRef<HTMLInputElement>(null);
  const listRef=useRef<HTMLDivElement>(null);
  const [query,setQuery]=useState(''),[open,setOpen]=useState(false),[highlight,setHighlight]=useState(0);
  const [requested,setRequested]=useState(false),[refresh,setRefresh]=useState(0);
  const [options,setOptions]=useState<ProjectMemberOption[]>([]),[loading,setLoading]=useState(false),[error,setError]=useState(false);
  useEffect(()=>{
    if(!requested)return;
    const controller=new AbortController();setLoading(true);setError(false);
    void apiJson<{members:ProjectMemberOption[]}>('/api/projects/members',{signal:controller.signal})
      .then(value=>{if(!controller.signal.aborted)setOptions(value.members);})
      .catch(()=>{if(!controller.signal.aborted)setError(true);})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return ()=>controller.abort();
  },[requested,refresh]);
  const candidates=options.filter(option=>!members.some(member=>key(member)===key(option))).map(option=>({id:key(option),name:option.subscriberId,kind:option.subscriberType==='AGENT'?'Agent' as const:'Person' as const,inConversation:false}));
  const ranked=rankMentions(candidates,query.trim().replace(/^@/,''));
  const shown=ranked.slice(0,8);
  const active=Math.min(highlight,Math.max(0,shown.length-1));
  const visible=open&&!disabled;
  const ready=visible&&!loading&&!error;
  useEffect(()=>{listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({block:'nearest'});},[active,query]);
  function choose(index:number) {
    if(disabled||loading||error||members.length>=50)return;
    const candidate=shown[index];
    const option=candidate&&options.find(option=>key(option)===candidate.id);
    if(!option)return;
    onChange([...members,{subscriberType:option.subscriberType,subscriberId:option.subscriberId}]);
    setQuery('');setHighlight(0);inputRef.current?.focus();setOpen(false);
  }
  function onKeyDown(event:KeyboardEvent<HTMLInputElement>) {
    if(event.nativeEvent.isComposing||event.keyCode===229||event.ctrlKey||event.metaKey||event.altKey)return;
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setOpen(false);return;}
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){
      event.preventDefault();setRequested(true);setOpen(true);
      setHighlight(!open?0:shown.length?(active+(event.key==='ArrowDown'?1:-1)+shown.length)%shown.length:0);return;
    }
    if(event.key==='Enter'){
      event.preventDefault();if(ready)choose(active);
    }
  }
  return <div className="project-member-control" onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))setOpen(false);}}>
    {members.length>0&&<ul className="project-selected-members" aria-label="Selected teammates">{members.map(member=><li key={key(member)}><Avatar member={member} size={24}/><span>{member.subscriberId}</span><button type="button" disabled={disabled} aria-label={`Remove ${member.subscriberId}`} onClick={()=>onChange(members.filter(value=>key(value)!==key(member)))}>×</button></li>)}</ul>}
    <div className="project-member-search">
      <span className="project-member-search-at" aria-hidden="true"><DesignIcon name="search"/></span>
      <input ref={inputRef} role="combobox" aria-label="Add people or agents" aria-expanded={visible} aria-controls={visible?id:undefined} aria-autocomplete="list" aria-activedescendant={ready&&shown[active]?`${id}-${active}`:undefined} aria-describedby={`${id}-help`} placeholder="Search names or type @" value={query} disabled={disabled} autoComplete="off"
        onFocus={()=>{setRequested(true);setOpen(true);setHighlight(0);}}
        onClick={()=>{setRequested(true);setOpen(true);}}
        onChange={event=>{setQuery(event.target.value);setHighlight(0);setOpen(true);}}
        onKeyDown={onKeyDown}/>
      {visible&&<div className="project-member-popup">
        {loading&&<p role="status">Loading your team…</p>}
        {error&&<p role="alert">We couldn’t load your team. <button type="button" className="project-inline-action" onClick={()=>setRefresh(value=>value+1)}>Try again</button></p>}
        <div ref={listRef} id={id} role="listbox" aria-label="People and agents" aria-busy={loading} className="project-member-options">
          {ready&&shown.map((candidate,index)=>{
            const member=options.find(option=>key(option)===candidate.id)!;
            return <button type="button" tabIndex={-1} role="option" id={`${id}-${index}`} key={candidate.id} aria-selected={index===active} disabled={members.length>=50} className="project-member-option" onPointerDown={event=>event.preventDefault()} onPointerMove={()=>setHighlight(index)} onClick={()=>choose(index)}>
              <Avatar member={member}/><span className="project-member-name"><strong>{member.subscriberId}</strong><small>{member.subscriberType==='HUMAN'?'Person':member.description||'Agent'}</small></span><span className="project-member-kind">{member.subscriberType==='HUMAN'?'Person':'Agent'}</span>
            </button>;
          })}
        </div>
        {ready&&!shown.length&&<p role="status">{query?'No matches. Try another name.':options.length?'Everyone available is already added.':'No teammates to add yet.'}</p>}
        {ready&&ranked.length>8&&<p className="project-picker-hint">Keep typing to find someone else.</p>}
        {members.length>=50&&<p role="status">You’ve added 50 teammates. Remove someone to add another.</p>}
      </div>}
    </div>
    <p id={`${id}-help`} className="project-picker-hint">Search people and agents. Use ↑↓ and Enter to add, Esc to close.</p>

  </div>;
}
