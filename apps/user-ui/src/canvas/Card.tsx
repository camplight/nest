// A chat card on the surface (the mock's `cardInner`): title and last activity, the apps used here, one row per
// participant with what they are doing now and a state dot, file tiles, and a footer with the newest Needs you reason
// (or Nudge, or Moving / All quiet) and Open. Memoized: it re-renders only when its card, pulse, needs or drag offset changes.
import {memo,useCallback,useState,useSyncExternalStore,type KeyboardEvent} from 'react';
import type {BoardCard} from '@nest/schemas';
import {AgentAvatar} from '../components/AgentAvatar';
import {fileHref} from '../attachments';
import {IntegrationLogo} from '../components/IntegrationLogo';
import {countOf} from '../app-activity';
import {serverClock} from '../server-clock';
import {fileSlots} from './FileTile';
import {ViewableFileTile} from './FileViewer';
import type {AgentPulse,CardPulse} from './pulse';
import type {NeedsItem} from './needs';
import {participantRows,shownRows,type ParticipantRow,type RowState} from './rows';
import {useServiceAgent} from './useFlows';
import {ForkIcon,LinkIcon} from './Links';
import {scheduleBadge} from './ScheduledList';
import type {ScheduleJob} from './schedule-jobs';

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
  /** This chat's Needs you items (unread mentions and reviews for the viewer), newest first. */
  needs?: readonly NeedsItem[];
  /** The signed-in person's username: their row reads `You`. */
  viewer?: string;
  onNudge?(channelId: string, agent: string): Promise<void>;
  /** Editors and owners only (never viewers): takes any card, open, locked or unavailable, off the canvas. */
  onRemove?(channelId: string): void;
  /** Opens the chat; only open cards use it. Locked and unavailable cards never open. */
  onOpen?(channelId: string): void;
  /** This card's chat is the one open now. */
  open?: boolean;
  /** The chat has a window over the canvas (a lighter ring than the active chat's `is-open`). */
  windowed?: boolean;
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
  /**
   * Hand-offs are set up and this is an open card: the `+` port on its right edge (drag it onto another chat) and the
   * footer's connect button, which opens the chat picker under itself.
   */
  onConnect?(channelId: string, anchor: HTMLElement): void;
  /** A dragged `+` port is over this card: releasing here connects to it (the mock's `.linktarget`). */
  linkTarget?: boolean;
  /** This chat's scheduled jobs (flows set up): the mock's badge under the last activity. */
  schedules?: readonly ScheduleJob[];
  /**
   * Editors (with `draggable`): the card is a Tab stop and a key pressed on the card itself (never on a control inside it)
   * goes here, for arrow-key moves. `moveHint` is the id of the text that says so.
   */
  onMoveKey?(channelId: string, event: KeyboardEvent<HTMLElement>): void;
  moveHint?: string;
};
export const CONNECT_TITLE = 'Connect: pass this chat\'s results to another chat';
export const PORT_TITLE = 'Drag to another chat to pass results along';

const NO_NEEDS: readonly NeedsItem[] = [];
/** Clicks here act on their own control (or start a face drag), never open the chat. Other faces open it like the rest of the card. */
const OWN_CLICK = 'button, a, input, textarea, select, .canvas-card-face[data-drag], [data-port]';

export function cardTitle(card: BoardCard) {
  return card.access === 'open' ? card.title || 'Untitled chat' : card.access === 'locked' ? 'Private chat' : 'This chat is no longer available';
}

const STATE_LABEL: Record<RowState, string> = {
  working: 'working', quiet: 'gone quiet', interrupted: 'stopped unexpectedly', done: 'done', failed: 'ran into an error', idle: 'idle',
  unavailable: 'unavailable', waiting: 'waiting on you', posted: 'posted here',
};
/** One line for an agent, or null for idle and done. The phone list uses it; cards show participant rows instead. */
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
/** The mock's compact `c-last`: `now`, `5m`, `2h`, `3d`. */
export function shortAgo(at: number, now: number) {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}
function LastActivity({at}: {at: number}) {
  useSyncExternalStore(subscribeMinute, () => minute);
  const now = Date.now();
  return <time className="canvas-card-activity" dateTime={new Date(at).toISOString()} title={`Active ${ago(at, now)}`}>
    <span className="canvas-visually-hidden">Active {ago(at, now)}</span><span aria-hidden="true">{shortAgo(at, now)}</span>
  </time>;
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
    <button type="button" className="canvas-card-nudge" disabled={busy} onClick={() => void nudge()}>Nudge {agent}</button>
    {failed ? <span className="canvas-card-error" role="alert">Could not send. Try again.</span> : null}
  </>;
}

const MAX_APP_LOGOS = 4;
/**
 * The apps this chat's agents used, under the title (the mock's `c-apps`): up to four logos, each named by how many reads
 * and changes, then the app's name or `N apps`. A ring marks an app with a call in flight.
 */
function AppLogos({apps}: {apps: CardPulse['apps']['apps']}) {
  const names = apps.map(app => `${app.appName}${app.running ? ' (now)' : ''}`).join(', ');
  return <div className="canvas-card-apps-row">
    <ul className="canvas-card-apps" aria-label="Apps used">
      {apps.slice(0, MAX_APP_LOGOS).map(app => {
        const text = `${app.appName}: ${countOf(app.reads, 'read')} · ${countOf(app.changes, 'change')}`;
        return <li key={app.app} className={`canvas-card-app${app.running ? ' is-live' : ''}`} role="img" aria-label={text} title={text}>
          <IntegrationLogo toolkit={app.app}/>
        </li>;
      })}
    </ul>
    <em className="canvas-card-apps-name" title={`Apps used in this chat: ${names}`}>{apps.length === 1 ? apps[0].appName : `${apps.length} apps`}</em>
  </div>;
}

/** One participant (the mock's `partRow`): face, name, live activity (with the app in use) and a state dot. */
function Row({row, facesDraggable, lifted}: {row: ParticipantRow; facesDraggable: boolean; lifted: boolean}) {
  const agent = row.kind === 'agent';
  return <li className="canvas-card-row" data-state={row.state} data-kind={row.kind}>
    {agent
      ? <span className={`canvas-card-face${lifted ? ' is-lifted' : ''}`} role="img" data-agent={row.name} data-state={row.state}
          data-drag={facesDraggable ? 'face' : undefined} aria-label={`${row.name}, ${STATE_LABEL[row.state]}`}
          title={facesDraggable ? `Drag ${row.name} off the card to remove` : row.name}>
          <AgentAvatar name={row.name} size={24}/>
        </span>
      : <span className="canvas-card-face is-human" role="img" aria-label={`${row.label}, ${STATE_LABEL[row.state]}`} title={row.name}>{initials(row.name)}</span>}
    <span className="canvas-card-who">{row.label}</span>
    <span className="canvas-card-what" title={row.text || undefined}>
      {row.app ? <span className="canvas-card-row-app"><IntegrationLogo toolkit={row.app.app}/></span> : null}{row.text}
    </span>
    {row.state === 'quiet' ? <span className="canvas-card-zz" aria-hidden="true">z z</span> : <i className="canvas-card-dot" aria-hidden="true"/>}
  </li>;
}

/** The card's tile row: the width the row may use (it takes the card's right padding, so a 264 px card holds four tiles). */
export const cardFilesWidth = (cardWidth: number) => cardWidth - 22;

/**
 * The files posted after this card mounted (by their message's server time): their tiles pop in once. Files already
 * there when the canvas opens never pop, however late the seed arrives; a tile leaves the set when its pop ends, so a
 * re-display (compact zoom and back) does not replay it.
 */
export function freshFiles(files: readonly {fileId: string; at: number}[], mountedAt: number, popped: ReadonlySet<string>) {
  return new Set(files.filter(file => file.at > mountedAt && !popped.has(file.fileId)).map(file => file.fileId));
}
function useFreshFiles(files: readonly {fileId: string; at: number}[] | undefined) {
  const [mountedAt] = useState(() => serverClock.serverNow());
  const [popped, setPopped] = useState<ReadonlySet<string>>(() => new Set());
  const fresh = freshFiles(files ?? [], mountedAt, popped);
  const done = useCallback((fileId: string) => setPopped(current => new Set(current).add(fileId)), []);
  return {fresh, done};
}

/** The mock's `c-arts`: the newest files as tiles, as many as fit, the last slot `+N` (it opens the chat) when more were posted. */
function CardFiles({files, total, width, fresh, onPopped, onMore}: {
  files: CardPulse['artifacts']; total: number; width: number; fresh: ReadonlySet<string>; onPopped(fileId: string): void; onMore?(): void;
}) {
  const {shown, more} = fileSlots(cardFilesWidth(width), Math.max(total, files.length), files.length);
  return <ul className="canvas-card-files" aria-label="Files">
    {files.slice(0, shown).map(file => <ViewableFileTile key={file.fileId} name={file.name} mime={file.mime} href={fileHref(file.fileId)}
      fresh={fresh.has(file.fileId)} onPopped={() => onPopped(file.fileId)}/>)}
    {more ? <li className="canvas-file-tile is-more">
      <button type="button" aria-label={`${more} more ${more === 1 ? 'file' : 'files'}`} title="Open the chat to see every file" disabled={!onMore} onClick={onMore}>+{more}</button>
    </li> : null}
  </ul>;
}

function OpenBody({card, pulse, needs, viewer, onNudge, facesDraggable, draggingFace, onOpen, onRemove, onConnect}: {
  card: Extract<BoardCard, {access: 'open'}>; pulse?: CardPulse; needs: readonly NeedsItem[]; viewer: string; onNudge?: CardProps['onNudge'];
  facesDraggable: boolean; draggingFace: string | null; onOpen?(channelId: string): void; onRemove?(channelId: string): void;
  onConnect?: CardProps['onConnect'];
}) {
  const title = cardTitle(card);
  const service = useServiceAgent();
  const rows = participantRows({participants: card.participants, pulse, needs, viewer, service});
  const {shown, hidden} = shownRows(rows);
  const quiet = rows.find(row => row.kind === 'agent' && row.state === 'quiet');
  const newest = needs[0];
  const {fresh, done: popped} = useFreshFiles(pulse?.artifacts);
  // The mock's footer: the newest reason first, else Nudge for a quiet agent, else whether anything is moving.
  const foot = newest
    ? <button type="button" className="canvas-card-need" aria-label={`Needs you: ${newest.short}${needs.length > 1 ? `, and ${needs.length - 1} more` : ''}. Open the chat`}
        title={needs.map(item => item.detail).join('\n')} disabled={!onOpen} onClick={() => onOpen?.(card.channelId)}>
        <i aria-hidden="true"/><span className="canvas-card-need-text">{newest.short}</span>
        {needs.length > 1 ? <span className="canvas-card-need-more" aria-hidden="true">+{needs.length - 1}</span> : null}
      </button>
    : quiet && onNudge ? <NudgeButton channelId={card.channelId} agent={quiet.name} onNudge={onNudge}/>
    : <span className="canvas-card-calm">{rows.some(row => row.state === 'working') ? 'Moving' : 'All quiet'}</span>;
  return <>
    {pulse?.apps.apps.length ? <AppLogos apps={pulse.apps.apps}/> : null}
    {rows.length || newest || quiet ? <div className="canvas-card-people">
      {rows.length ? <ul className="canvas-card-rows" aria-label="Participants">
        {shown.map(row => <Row key={`${row.kind}:${row.name}`} row={row} facesDraggable={facesDraggable && row.kind === 'agent'} lifted={row.kind === 'agent' && row.name === draggingFace}/>)}
        {hidden ? <li className="canvas-card-rows-more">+{hidden} more</li> : null}
      </ul> : null}
      {/* Compact zoom only: a coral dot when something needs you, else `quiet` (the mock's far card). */}
      {newest ? <span className="canvas-card-far" data-kind="needs" role="img" aria-label={`Needs you: ${needs.length}`}/>
        : quiet ? <span className="canvas-card-far" data-kind="quiet">quiet</span> : null}
    </div> : null}
    {pulse?.artifacts.length ? <CardFiles files={pulse.artifacts} total={pulse.fileCount} width={card.w} fresh={fresh} onPopped={popped}
      onMore={onOpen ? () => onOpen(card.channelId) : undefined}/> : null}
    <div className="canvas-card-foot">
      {foot}
      <span className="canvas-card-foot-end">
        {onRemove ? <button type="button" className="canvas-card-remove" aria-label="Remove from canvas" title="Remove from canvas (the chat stays)"
          onClick={() => onRemove(card.channelId)}><span aria-hidden="true">✕</span></button> : null}
        {onConnect ? <button type="button" className="ib sm canvas-card-connect" data-act="linkpick" aria-label={CONNECT_TITLE} title={CONNECT_TITLE}
          aria-haspopup="dialog" onClick={event => onConnect(card.channelId, event.currentTarget)}><LinkIcon/></button> : null}
        {/* The body opens the chat too; this is the visible and keyboard route. */}
        {onOpen ? <button type="button" className="canvas-card-open" aria-label={`Open chat ${title}`} onClick={() => onOpen(card.channelId)}>Open</button> : null}
      </span>
    </div>
  </>;
}

export const Card = memo(function Card({card, draggable, dx, dy, dragging, measure, pulse, needs = NO_NEEDS, viewer = '', onNudge, onRemove, onOpen, open = false, windowed = false,
  facesDraggable = false, draggingFace = null, dropping = false, selected = false, areaTitle, areaTint, onConnect, linkTarget = false, schedules, onMoveKey, moveHint}: CardProps) {
  const title = cardTitle(card);
  const ref = useCallback((element: HTMLElement | null) => measure(card.channelId, element), [card.channelId, measure]);
  const opens = card.access === 'open' && onOpen ? onOpen : undefined;
  const attention = card.access === 'open' && needs.length > 0;
  const connects = card.access === 'open' ? onConnect : undefined;
  const moveKey = draggable ? onMoveKey : undefined;
  return <article
    ref={ref}
    className={`canvas-card${dragging ? ' is-dragging' : ''}${opens ? ' is-openable' : ''}${open ? ' is-open' : ''}${windowed ? ' is-windowed' : ''}${dropping ? ' is-drop-target' : ''}${selected ? ' is-selected' : ''}${areaTitle ? ' in-area' : ''}${attention ? ' needs-you' : ''}${linkTarget ? ' linktarget' : ''}`}
    data-channel-id={card.channelId}
    data-tint={areaTitle ? areaTint : undefined}
    data-access={card.access}
    data-drag={draggable ? 'card' : undefined}
    aria-label={`Chat ${title}`}
    aria-current={open ? 'true' : undefined}
    tabIndex={moveKey ? 0 : undefined}
    aria-describedby={moveKey ? moveHint : undefined}
    onKeyDown={moveKey ? event => { if (event.target === event.currentTarget) moveKey(card.channelId, event); } : undefined}
    onClick={opens ? event => { if (!(event.target as Element).closest(OWN_CLICK)) opens(card.channelId); } : undefined}
    style={{width: card.w, transform: `translate(${card.x + dx}px, ${card.y + dy}px)`}}>
    <div className="canvas-card-head">
      <h3 className="canvas-card-title">{title}</h3>
      {/* The mock's c-last over the schedule badge, right-aligned in one column. */}
      {card.access === 'open' && (pulse?.lastActivityAt || schedules?.length) ? <span className="canvas-card-meta">
        {pulse?.lastActivityAt ? <LastActivity at={pulse.lastActivityAt}/> : null}
        {scheduleBadge(schedules)}
      </span> : null}
    </div>
    {/* The mock's c-fork: which chat this one was forked from ('another chat' when the viewer cannot read it). */}
    {card.access === 'open' && card.forkOf ? <p className="c-fork"><ForkIcon/>fork of {card.forkOf.title}</p> : null}
    {areaTitle ? <p className="canvas-visually-hidden">In area {areaTitle}</p> : null}
    {card.access === 'open' && card.home && !card.home.isHere && card.home.label ? <p className="canvas-card-home">context from {card.home.label}</p> : null}
    {/* The home's setter can no longer read its canvas, so agents read nothing from it; same tag as an unavailable link. */}
    {card.access === 'open' && card.home?.available === false ? <p className="canvas-card-home" title="Agents in this chat read no context until a member uses an area's context again">context <span className="canvas-context-tag">unavailable</span></p> : null}
    {card.access === 'open' ? <OpenBody card={card} pulse={pulse} needs={needs} viewer={viewer} onNudge={onNudge} facesDraggable={facesDraggable}
      draggingFace={draggingFace} onOpen={opens} onRemove={onRemove} onConnect={connects}/> : null}
    {card.access === 'locked' ? <p className="canvas-card-owner">Owner: {card.ownerLabel}</p> : null}
    {/* Every card can come off the canvas; the chat itself is untouched and an open one returns to Loose chats. */}
    {card.access !== 'open' && onRemove ? <div className="canvas-card-actions">
      <button type="button" className="canvas-card-remove" onClick={() => onRemove(card.channelId)}>Remove from canvas</button>
    </div> : null}
    {/* Pointer only: the footer's connect button is the keyboard route. Hidden on the open card and at far zoom (CSS). */}
    {connects && !open ? <span className="port" data-port title={PORT_TITLE} aria-hidden="true"/> : null}
  </article>;
});
