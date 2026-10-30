import {useEffect,useRef,useState} from 'react';
import type {Agent, Channel} from '../types';
import {AgentAvatar} from './AgentAvatar';
import {DesignIcon} from '../Dashboard';
import './agent-navigation.css';

export function AgentNavigation({agents, chats, activeAgent, activeChannelId, inAgents, busy, error, unread, label, onBrowse, onOpen, onChat, onNew}: {
  agents: Agent[]; chats: Map<string, Channel[]>; activeAgent: string | null; activeChannelId: string | null;
  inAgents: boolean; busy: boolean; error: string; unread: Record<string, number>; label: (channel:Channel)=>string;
  onBrowse:()=>void; onOpen:(name:string)=>void; onChat:(id:string)=>void; onNew:(name:string)=>void;
}) {
  const [expanded,setExpanded]=useState(true);
  const [opened,setOpened]=useState<string|null>(activeAgent);
  const [query,setQuery]=useState('');
  const listRef=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    if(activeAgent){setOpened(activeAgent);setExpanded(true);setQuery('');}
  },[activeAgent]);
  useEffect(()=>{
    const list=listRef.current;
    if(!list||query)return;
    const selected=list.querySelectorAll<HTMLElement>('[aria-current="page"]');
    const target=selected[selected.length-1];
    if(!target)return;
    const bounds=list.getBoundingClientRect(),item=target.getBoundingClientRect();
    if(item.bottom>bounds.bottom)list.scrollTop+=item.bottom-bounds.bottom;
    else if(item.top<bounds.top)list.scrollTop-=bounds.top-item.top;
  },[activeAgent,activeChannelId,expanded,query]);
  const names=[...new Set([...agents.map(a=>a.name),...chats.keys()])];
  const matchingNames=names.filter(name=>name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <div className="agent-navigation">
    <button data-tour="agents" aria-current={inAgents?'page':undefined} aria-expanded={expanded} aria-controls="agent-shortcuts" onClick={()=>setExpanded(v=>!v)}><DesignIcon name="agents"/>Agents <span className="agent-chevron" aria-hidden="true">{expanded?'−':'+'}</span></button>
    {expanded && <div id="agent-shortcuts">
      <button className="agent-browse" onClick={onBrowse}>All agents</button>
      {names.length>5&&<label className="agent-sidebar-search"><input aria-label="Search agents in sidebar" type="search" placeholder="Find an agent…" value={query} onChange={event=>setQuery(event.target.value)} onKeyDown={event=>{if(event.key==='Escape')setQuery('');}}/></label>}
      <div ref={listRef} className="agent-shortcuts-scroll" role="region" aria-label="Agent shortcuts" tabIndex={0}>
      {matchingNames.map(name=>{
        const isOpen=opened===name;
        const unreadCount=(chats.get(name)??[]).reduce((total,chat)=>total+(unread[chat.id]??0),0);
        return <div className="agent-shortcut" key={name}>
        <div className="agent-shortcut-heading">
          <button className="agent-open" aria-current={activeAgent===name?'page':undefined} disabled={busy} title={name} onClick={()=>{setOpened(name);setQuery('');onOpen(name);}}><AgentAvatar name={name} size={28}/><span>{name}</span>{unreadCount>0&&<em className="agent-unread" aria-label={`${unreadCount} unread messages`}>{unreadCount}</em>}</button>
          <button className="agent-expand" aria-label={`Conversations with ${name}`} aria-expanded={isOpen} onClick={()=>setOpened(isOpen?null:name)}>{isOpen?'−':'+'}</button>
        </div>
        {isOpen && <div className="agent-chat-links">
          {(chats.get(name)??[]).map(chat=><button key={chat.id} aria-current={activeChannelId===chat.id?'page':undefined} onClick={()=>onChat(chat.id)}><span>{label(chat)}{chat.archivedAt?' · Archived':''}</span>{!!unread[chat.id]&&<em>{unread[chat.id]}</em>}</button>)}
          <button disabled={busy} onClick={()=>onNew(name)} aria-label={`New chat with ${name}`}>＋ New chat</button>
        </div>}
      </div>;})}
      {!matchingNames.length&&<p className="agent-sidebar-empty">No matching agents.</p>}
      </div>
      {error&&<p className="agent-navigation-error" role="alert">{error}</p>}
    </div>}
  </div>;
}

export type AgentTab = 'settings' | 'connections';
export function AgentWorkspaceTabs({name,tab,onChat,onTab}:{name:string;tab:AgentTab|'chat';onChat:()=>void;onTab:(tab:AgentTab)=>void}) {
  return <nav className="agent-workspace-tabs" aria-label={`${name} workspace`}>
    <button aria-current={tab==='chat'?'page':undefined} onClick={onChat}>Chat</button>
    <button aria-current={tab==='settings'?'page':undefined} onClick={()=>onTab('settings')}>Settings</button>
    <button aria-current={tab==='connections'?'page':undefined} onClick={()=>onTab('connections')}>Connected apps</button>
  </nav>;
}
