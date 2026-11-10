// A chat card on the surface: title, faces with live state, a status line with Nudge, artifacts,
// last activity and needs-you. Memoized: it re-renders only when its card, pulse or drag offset changes.
import {memo,useCallback,useState,useSyncExternalStore} from 'react';
import type {BoardCard} from '@nest/schemas';
import {AgentAvatar} from '../components/AgentAvatar';
import {fileHref} from '../attachments';
import {IntegrationLogo} from '../components/IntegrationLogo';
import type {AgentPulse,CardPulse} from './pulse';

export type CardProps = {
  card: BoardCard;
  /** Editors can move every card, including locked and unavailable ones; viewers move none. */
  draggable: boolean;
  /** Drag preview offset in canvas units; the stored position changes only on drop. */
  dx: number;
  dy: number;
  dragging: boolean;
  /** Reports the mounted element so the surface can measure its height. */
  measure(channelId: string, element: HTMLElement | null): void;
  /** Live state for an open card; absent until the first seed arrives. */
  pulse?: CardPulse;
  onNudge?(channelId: string, agent: string): Promise<void>;
  /** Editors and owners only (never viewers): takes any card, open, locked or unavailable, off the canvas. */
  onRemove?(channelId: string): void;
  /** Opens the chat; only open cards use it. Locked and unavailable cards never open. */
  onOpen?(channelId: string): void;
  /** This card's chat is the one open now. */
  open?: boolean;
  /** The person may add and remove this chat's agents: agent faces get a drag handle (drag off to remove). */
  facesDraggable?: boolean;
  /** The agent whose face is being dragged off this card right now. */
  draggingFace?: string | null;
  /** An agent is being dragged over this card. */
  dropping?: boolean;
  /** The card the agent tray suggests for. */
  selected?: boolean;
  /** The area this card sits in (by centre), shown as a stripe in its tint; absent outside areas. */
  areaTitle?: string;
  areaTint?: string;
};

const MAX_FACES = 5;
/** Clicks here act on their own control, never open the chat. */
const OWN_CLICK = 'button, a, input, textarea, select, .canvas-card-faces';
const MAX_LINES = 3;

export function cardTitle(card: BoardCard) {
  return card.access === 'open' ? card.title || 'Untitled chat' : card.access === 'locked' ? 'Private chat' : 'This chat is no longer available';
}

const STATE_LABEL: Record<AgentPulse['state'], string> = {
  working: 'working', quiet: 'quiet', interrupted: 'stopped unexpectedly', done: 'done', failed: 'ran into an error', idle: 'idle', unavailable: 'unavailable',
};
/** The status line for an agent, or null for idle and done (shown once per card instead). */
export function statusText(agent: AgentPulse) {
  switch (agent.state) {
    case 'working': return `${agent.name} is working`;
    case 'quiet': return `${agent.name} quiet for ${agent.quietMinutes ?? 0} min`;
    case 'interrupted': return `${agent.name} stopped unexpectedly`;
    case 'failed': return `${agent.name} ran into an error`;
    case 'unavailable': return `${agent.name} is unavailable`;
    default: return null;
  }
}
const initials = (name: string) => name.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean).slice(0, 2).map(word => word[0]).join('').toUpperCase() || '?';

// One shared minute tick for every "last activity" label, instead of a timer per card.
const minuteListeners = new Set<() => void>();
let minuteTimer: ReturnType<typeof setInterval> | null = null;
let minute = Math.floor(Date.now() / 60_000);
function subscribeMinute(listener: () => void) {
  minuteListeners.add(listener);
  minuteTimer ??= setInterval(() => {
    const next = Math.floor(Date.now() / 60_000);
    if (next === minute) return;
    minute = next;
    for (const notify of [...minuteListeners]) notify();
  }, 15_000);
  return () => {
    minuteListeners.delete(listener);
    if (!minuteListeners.size && minuteTimer) { clearInterval(minuteTimer); minuteTimer = null; }
  };
}
export function ago(at: number, now: number) {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}
function LastActivity({at}: {at: number}) {
  useSyncExternalStore(subscribeMinute, () => minute);
  return <p className="canvas-card-activity"><time dateTime={new Date(at).toISOString()}>Active {ago(at, Date.now())}</time></p>;
}

function NudgeButton({channelId, agent, onNudge}: {channelId: string; agent: string; onNudge(channelId: string, agent: string): Promise<void>}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  async function nudge() {
    if (busy) return;
    setBusy(true); setFailed(false);
    try { await onNudge(channelId, agent); } catch { setFailed(true); } finally { setBusy(false); }
  }
  return <>
    <button type="button" className="canvas-card-nudge" aria-label={`Nudge ${agent}`} disabled={busy} onClick={() => void nudge()}>Nudge</button>
    {failed ? <span className="canvas-card-error" role="alert">Could not send. Try again.</span> : null}
  </>;
}

const MAX_APP_LOGOS = 4;
/** The apps this chat's agents used: logos in one row with +N, each named by how many reads and changes. */
function AppLogos({apps}: {apps: CardPulse['apps']['apps']}) {
  return <ul className="canvas-card-apps" aria-label="Apps used">
    {apps.slice(0, MAX_APP_LOGOS).map(app => {
      const text = `${app.appName}: ${app.reads} reads · ${app.changes} changes`;
      return <li key={app.app} className={`canvas-card-app${app.running ? ' is-live' : ''}`} role="img" aria-label={text} title={text}>
        <IntegrationLogo toolkit={app.app}/>
      </li>;
    })}
    {apps.length > MAX_APP_LOGOS ? <li className="canvas-card-apps-more" title={apps.slice(MAX_APP_LOGOS).map(app => app.appName).join(', ')}>+{apps.length - MAX_APP_LOGOS}</li> : null}
  </ul>;
}

function OpenBody({card, pulse, onNudge, facesDraggable, draggingFace}: {
  card: Extract<BoardCard, {access: 'open'}>; pulse?: CardPulse; onNudge?: CardProps['onNudge']; facesDraggable: boolean; draggingFace: string | null;
}) {
  const agents = pulse?.agents ?? card.participants.filter(p => p.subscriberType === 'AGENT').map(p => ({name: p.subscriberId, state: 'idle' as const, since: 0}));
  const humans = card.participants.filter(p => p.subscriberType === 'HUMAN').map(p => p.subscriberId);
  const faces = agents.length + humans.length, hidden = Math.max(0, faces - MAX_FACES);
  const shownAgents = agents.slice(0, MAX_FACES), shownHumans = humans.slice(0, MAX_FACES - shownAgents.length);
  const lines = agents.filter(agent => statusText(agent) !== null);
  const done = !lines.length && agents.some(agent => agent.state === 'done');
  const quiet = agents.some(agent => agent.state === 'quiet');
  return <>
    {faces ? <div className="canvas-card-faces" aria-label="Participants">
      {shownAgents.map(agent => <span key={agent.name} className={`canvas-card-face${agent.name === draggingFace ? ' is-lifted' : ''}`} role="img"
        data-agent={agent.name} data-state={agent.state} data-drag={facesDraggable ? 'face' : undefined}
        aria-label={`${agent.name}, ${STATE_LABEL[agent.state]}`}
        title={`${agent.name}: ${STATE_LABEL[agent.state]}${facesDraggable ? '. Drag off the card to remove' : ''}`}>
        <AgentAvatar name={agent.name} size={28}/><i className="canvas-card-dot" aria-hidden="true"/>
      </span>)}
      {shownHumans.map(name => <span key={name} className="canvas-card-human" role="img" aria-label={name} title={name}>{initials(name)}</span>)}
      {hidden ? <span className="canvas-card-more">+{hidden}</span> : null}
    </div> : null}
    {quiet ? <p className="canvas-card-marker" data-kind="quiet">Quiet</p> : null}
    {lines.length || done ? <ul className="canvas-card-status">
      {lines.slice(0, MAX_LINES).map(agent => <li key={agent.name} data-state={agent.state}>
        <span>{statusText(agent)}</span>
        {agent.state === 'quiet' && onNudge ? <NudgeButton channelId={card.channelId} agent={agent.name} onNudge={onNudge}/> : null}
      </li>)}
      {lines.length > MAX_LINES ? <li className="canvas-card-more-lines">+{lines.length - MAX_LINES} more</li> : null}
      {done ? <li data-state="done">Done</li> : null}
    </ul> : null}
    {pulse?.artifacts.length ? <ul className="canvas-card-artifacts" aria-label="Files">
      {pulse.artifacts.map(file => <li key={file.fileId}>
        <a className="canvas-card-chip" href={fileHref(file.fileId)} target="_blank" rel="noreferrer" title={file.name}>{file.name}</a>
      </li>)}
    </ul> : null}
    {pulse?.apps.apps.length ? <AppLogos apps={pulse.apps.apps}/> : null}
    {pulse?.lastActivityAt ? <LastActivity at={pulse.lastActivityAt}/> : null}
  </>;
}

export const Card = memo(function Card({card, draggable, dx, dy, dragging, measure, pulse, onNudge, onRemove, onOpen, open = false,
  facesDraggable = false, draggingFace = null, dropping = false, selected = false, areaTitle, areaTint}: CardProps) {
  const title = cardTitle(card);
  const ref = useCallback((element: HTMLElement | null) => measure(card.channelId, element), [card.channelId, measure]);
  const needs = card.access === 'open' ? pulse?.needsYou.length ?? 0 : 0;
  const opens = card.access === 'open' && onOpen ? onOpen : undefined;
  return <article
    ref={ref}
    className={`canvas-card${dragging ? ' is-dragging' : ''}${opens ? ' is-openable' : ''}${open ? ' is-open' : ''}${dropping ? ' is-drop-target' : ''}${selected ? ' is-selected' : ''}${areaTitle ? ' in-area' : ''}`}
    data-channel-id={card.channelId}
    data-tint={areaTitle ? areaTint : undefined}
    data-access={card.access}
    data-drag={draggable ? 'card' : undefined}
    aria-label={`Chat ${title}`}
    aria-current={open ? 'true' : undefined}
    onClick={opens ? event => { if (!(event.target as Element).closest(OWN_CLICK)) opens(card.channelId); } : undefined}
    style={{width: card.w, transform: `translate(${card.x + dx}px, ${card.y + dy}px)`}}>
    <div className="canvas-card-head">
      <h3 className="canvas-card-title">{title}</h3>
      {/* Keyboard route to the same action; a pointer opens the card by clicking its body. */}
      {opens ? <button type="button" className="canvas-card-open" onClick={() => opens(card.channelId)}>Open chat {title}</button> : null}
      {needs ? <span className="canvas-card-needs" role="img" aria-label={`Needs you: ${needs}`} title="Needs you">{needs}</span> : null}
    </div>
    {areaTitle ? <p className="canvas-visually-hidden">In area {areaTitle}</p> : null}
    {card.access === 'open' && card.home && !card.home.isHere && card.home.label ? <p className="canvas-card-home">context from {card.home.label}</p> : null}
    {/* The home's setter can no longer read its canvas, so agents read nothing from it; same tag as an unavailable link. */}
    {card.access === 'open' && card.home?.available === false ? <p className="canvas-card-home" title="Agents in this chat read no context until a member uses an area's context again">context <span className="canvas-context-tag">unavailable</span></p> : null}
    {card.access === 'open' ? <OpenBody card={card} pulse={pulse} onNudge={onNudge} facesDraggable={facesDraggable} draggingFace={draggingFace}/> : null}
    {card.access === 'locked' ? <p className="canvas-card-owner">Owner: {card.ownerLabel}</p> : null}
    {/* Every card can come off the canvas; the chat itself is untouched and an open one returns to the pile. */}
    {onRemove ? <div className="canvas-card-actions">
      <button type="button" className="canvas-card-remove" onClick={() => onRemove(card.channelId)}>Remove from canvas</button>
    </div> : null}
  </article>;
});
