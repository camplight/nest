import {useEffect, useMemo, useRef, useState} from 'react';
import {Headphones, Maximize2, MessageSquare, Mic, MicOff, Minimize2, PhoneOff, Volume2, X} from 'lucide-react';
import {Dialog as DialogPrimitive} from 'radix-ui';
import {apiJson} from '../api';
import type {Agent, Channel, EventRow} from '../types';
import {AgentAvatar} from '../components/AgentAvatar';
import {buildTimeline} from '../chat/timeline';
import {MarkdownText} from '../chat/ui/MarkdownText';
import {MessageAttachments} from '../chat/attachments-view';
import {ChatPortalProvider} from '../chat/ui/portal';
import {Dialog, DialogContent} from '../chat/ui/dialog';
import {createHuddleSession, emptyHuddle, voiceAgents, type VoiceConfig} from './session';
import './huddle.css';

function elapsed(startedAt: number | null, now: number) {
  const seconds = startedAt === null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000));
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}

export default function Huddle({channel, label, username, agents, events, canPost, onClose}: {
  channel: Channel; label: string; username: string; agents: Agent[]; events: EventRow[]; canPost: boolean; onClose(): void;
}) {
  const [state, setState] = useState(emptyHuddle), [config, setConfig] = useState<VoiceConfig | null>(null);
  const [configError, setConfigError] = useState(false), [configAttempt, setConfigAttempt] = useState(0);
  const [expanded, setExpanded] = useState(false), [showChat, setShowChat] = useState(true), [now, setNow] = useState(Date.now);
  // Compare engine timestamps with engine timestamps, not the browser's clock.
  const [voiceBaseline] = useState(() => events.reduce((latest, event) => Math.max(latest, event.createdAt ?? 0), 0));
  const wave = useRef<HTMLDivElement>(null), conversation = useRef<HTMLDivElement>(null);
  const [session] = useState(() => createHuddleSession({channelId: channel.id, username, onChange: setState,
    onLevel: level => wave.current?.style.setProperty('--huddle-level', String(Math.min(1, Math.max(0, level * 5)))),
  }));
  const eligible = useMemo(() => voiceAgents(agents, channel.participants ?? []), [agents, channel.participants]);
  const [selected, setSelected] = useState(() => eligible.map(a => a.name));
  const [muting, setMuting] = useState(false);
  const connected = state.phase === 'joined' || state.phase === 'reconnecting';
  const busy = state.phase === 'joining';
  const allowed = canPost && !channel.archivedAt;
  const available = Boolean(config?.realtime?.rooms?.enabled && config.realtime.rooms.broker === 'livekit');
  const items = useMemo(() => buildTimeline(events.filter(e => e.channelId === channel.id), {currentUsername: username}).filter(item => item.kind === 'message').slice(-12), [events, channel.id, username]);
  const members = (channel.participants ?? []).filter(p => ['HUMAN', 'AGENT'].includes(p.subscriberType.toUpperCase()));
  const roster = members.map(p => ({name: p.subscriberId, agent: p.subscriberType.toUpperCase() === 'AGENT'}));
  for (const participant of state.participants) if (!roster.some(p => p.name === participant.name && p.agent === participant.agent)) roster.push({name: participant.name, agent: participant.agent});
  const lastVoice = connected ? [...events].reverse().find(e => e.channelId === channel.id && e.type === 'message.created' && (e.createdAt ?? 0) > voiceBaseline && Boolean((e.payload as {voice?: unknown})?.voice)) : undefined;
  const voiceText = lastVoice?.payload as {text?: string; voice?: {status?: string}} | undefined;
  const speaking = state.participants.filter(p => p.speaking).map(p => p.name);
  const status = state.phase === 'joining' ? 'Connecting…' : state.phase === 'reconnecting' ? 'Reconnecting…' : connected ? state.muted ? 'Microphone off' : speaking.length ? `${speaking.join(', ')} speaking` : 'Microphone on' : 'Ready when you are';
  useEffect(() => {
    const controller = new AbortController(); setConfigError(false); setConfig(null);
    void apiJson<VoiceConfig>('/api/voice/config', {signal: controller.signal}).then(setConfig).catch(() => {if (!controller.signal.aborted) setConfigError(true);});
    return () => controller.abort();
  }, [configAttempt]);
  useEffect(() => () => {void session.leave('closed');}, [session]);
  useEffect(() => {if (!allowed) void session.leave('access_changed');}, [allowed, session]);
  useEffect(() => {if (!connected) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer);}, [connected]);
  useEffect(() => {
    const panel = conversation.current;
    if (panel && panel.scrollHeight - panel.scrollTop - panel.clientHeight < 180) panel.scrollTop = panel.scrollHeight;
  }, [items]);
  useEffect(() => {
    const close = () => {void session.leave('page_closed');};
    window.addEventListener('pagehide', close);
    return () => window.removeEventListener('pagehide', close);
  }, [session]);
  const close = () => {void session.leave(); onClose();};
  const join = () => {
    if (!available || !allowed) return;
    if (!navigator.mediaDevices?.getUserMedia) {setConfigError(true); return;}
    void session.join(eligible.filter(a => selected.includes(a.name)).map(a => a.name));
  };
  const micSupported = Boolean(navigator.mediaDevices?.getUserMedia);

  return <ChatPortalProvider><Dialog open onOpenChange={open => {if (!open) close();}}>
    <DialogContent customLayout showCloseButton={false} className={`huddle-dialog${expanded ? ' huddle-expanded' : ''}`} onInteractOutside={event => event.preventDefault()}>
      <header className="huddle-header"><div><DialogPrimitive.Title className="huddle-title">Huddle</DialogPrimitive.Title><DialogPrimitive.Description className="huddle-subtitle">Talk through the work, together.</DialogPrimitive.Description></div>
        <div className="huddle-header-actions"><button type="button" aria-label={expanded ? 'Restore huddle size' : 'Expand huddle'} onClick={() => setExpanded(!expanded)}>{expanded ? <Minimize2/> : <Maximize2/>}</button><button type="button" aria-label="Close huddle" onClick={close}><X/></button></div>
      </header>
      <div className={`huddle-body${showChat ? '' : ' huddle-people-only'}`}>
        {showChat && <section className="huddle-work" aria-label="Huddle conversation"><h2><span>#</span>{label}</h2>
          <div className="huddle-conversation nest-chat" ref={conversation}>
            {!items.length && <p className="huddle-empty">Your project conversation stays here while you talk.</p>}
            {items.map(item => item.kind === 'message' && <article className="huddle-message" key={item.id}>
              {item.meta.authorKind === 'agent' ? <AgentAvatar name={item.meta.authorName} size={32}/> : <span className="huddle-initials" aria-hidden="true">{item.meta.authorName.slice(0, 2).toUpperCase()}</span>}
              <div><header><strong>{item.meta.authorName}</strong><time>{new Date(item.meta.displayAt).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}</time></header>
                <MarkdownText text={item.text}/>{item.attachments.length > 0 && <MessageAttachments attachments={item.attachments}/>}</div>
            </article>)}
          </div>
          <section className="huddle-transcript" aria-label="Voice transcript">
            <div className="huddle-transcript-label"><span>Live transcript</span><span>{connected ? 'Saved in this chat' : 'Starts when you join'}</span></div>
            {typeof voiceText?.text === 'string' && voiceText.text ? <p>{voiceText.text}</p> : <p className="huddle-empty">{connected ? 'Spoken replies and transcripts appear here when a voice agent joins.' : 'Speak naturally. Keep the conversation and the work in one place.'}</p>}
            {voiceText?.voice?.status === 'failed' && <p role="alert">This audio could not be transcribed. You can continue in chat.</p>}
            <div className="huddle-audio" ref={wave} aria-hidden="true"><div className="huddle-wave">{Array.from({length: 72}, (_, i) => <span key={i} style={{'--bar': .12 + ((i * 17 + 7) % 31) / 31} as React.CSSProperties}/>)}</div><span className={`huddle-mic-indicator${state.muted ? ' is-muted' : ''}`}>{state.muted ? <MicOff/> : <Mic/>}</span></div>
            <div className="huddle-audio-caption"><time>{elapsed(state.startedAt, now)}</time><span role="status">{status}</span></div>
          </section>
        </section>}
        <aside className="huddle-team" aria-label="Huddle participants">
          <div className="huddle-tip"><Headphones aria-hidden="true"/><p>{connected ? 'Say the agent’s name when you ask a question or request an action.' : 'Bring your team together. Choose which voice agents to invite.'}</p></div>
          <div className="huddle-team-heading"><h2>People & agents</h2><span>{state.participants.length} in huddle</span></div>
          <ul className="huddle-participants">{roster.map(person => {
            const present = state.participants.filter(p => p.name === person.name && p.agent === person.agent);
            const audible = present.some(p => !p.muted), talking = present.some(p => p.speaking);
            const selectable = person.agent && eligible.some(a => a.name === person.name) && !connected && !busy;
            return <li key={`${person.agent}:${person.name}`} className={`${talking ? ' is-speaking' : ''}${present.length ? ' is-connected' : ''}`}>
              {person.agent ? <AgentAvatar name={person.name} size={68}/> : <span className="huddle-initials huddle-human-portrait" aria-hidden="true">{person.name.slice(0, 2).toUpperCase()}</span>}
              <strong>{person.name}{person.name === username && !person.agent ? ' (you)' : ''}</strong>
              <span className="huddle-participant-state">{present.length ? talking ? 'Speaking' : audible ? 'Connected' : 'Muted' : 'In chat'}</span>
              {selectable && <label className="huddle-agent-invite"><input type="checkbox" checked={selected.includes(person.name)} onChange={event => setSelected(current => event.target.checked ? [...current, person.name] : current.filter(name => name !== person.name))}/>Invite to huddle</label>}
            </li>;
          })}</ul>
          {!eligible.length && <p className="huddle-team-note">You can talk with teammates. For spoken AI replies, add an agent configured with a realtime voice model. <a href="?view=agents">Manage agents</a></p>}
        </aside>
      </div>
      <div className="huddle-notices">
        {state.error && <p role="alert">{state.error}</p>}
        {!allowed ? <p role="status">Huddles are available to members who can send messages in this chat.</p>
          : !micSupported ? <p role="alert">Your browser cannot access a microphone here. Open Nest over HTTPS in a supported browser.</p>
          : configError ? <p role="alert">We couldn’t check voice availability. <button type="button" onClick={() => setConfigAttempt(value => value + 1)}>Try again</button></p>
          : !config ? <p role="status">Checking voice availability…</p>
          : !available ? <p role="status">Huddles need the LiveKit room service. Ask your administrator to finish voice setup.</p> : null}
        {state.audioBlocked && <button type="button" className="huddle-enable-audio" onClick={() => void session.enableAudio()}><Volume2 size={17}/>Enable sound</button>}
      </div>
      <footer className="huddle-controls"><div>
        <button type="button" className={`huddle-control${connected && !state.muted ? ' is-active' : ''}`} aria-label={state.muted ? 'Unmute microphone' : 'Mute microphone'} aria-pressed={connected && !state.muted} disabled={state.phase !== 'joined' || muting} onClick={async () => {setMuting(true); await session.mute(!state.muted); setMuting(false);}}>{state.muted ? <MicOff/> : <Mic/>}<span>{state.muted ? 'Unmute' : 'Microphone'}</span></button>
        <button type="button" className={`huddle-control${showChat ? ' is-active' : ''}`} aria-label={showChat ? 'Hide conversation' : 'Show conversation'} aria-pressed={showChat} onClick={() => setShowChat(!showChat)}><MessageSquare/><span>Chat</span></button>
      </div><div>{!connected && <button type="button" className="huddle-join" disabled={busy || !allowed || !available || !micSupported} onClick={join}><Headphones size={18}/>{busy ? 'Connecting…' : 'Join huddle'}</button>}<button type="button" className={connected || busy ? 'huddle-leave' : 'huddle-close'} onClick={close}>{connected ? 'Leave' : busy ? 'Cancel' : 'Close'}<PhoneOff size={17}/></button></div></footer>
    </DialogContent>
  </Dialog></ChatPortalProvider>;
}
