// Canvas view: top bar, first-canvas prompt, notices and the board surface.
import {useEffect,useMemo,useState,useSyncExternalStore,type FormEvent,type ReactNode} from 'react';
import type {Canvas,Project} from '@nest/schemas';
import type {Agent,Channel} from '../types';
import {WorkspaceTopbar} from '../components/WorkspaceTopbar';
import {ApiError,apiJson,getApiHeaders} from '../api';
import {boardApi,createCanvas,listCanvases} from './api';
import {createBoardStore} from './board-store';
import {Surface} from './Surface';
import {nudgeMessage,type CanvasLive} from './live';
import './canvas.css';

export type CanvasHuman = {id?: string; username: string};
export type CanvasChatMode = 'focus' | 'split';
export type CanvasViewProps = {
  canvasId: string | null;
  humanId: string;
  username: string;
  channels: Channel[];
  projects: Project[];
  agents: Agent[];
  humans: CanvasHuman[];
  /** `replace` swaps the history entry, for redirects that Back should skip. */
  onSelectCanvas(id: string | null, options?: {replace?: boolean}): void;
  onMenu(): void;
  chat: ReactNode;
  chatChannelId: string | null;
  chatMode: CanvasChatMode | null;
  onOpenChat(channelId: string, mode: CanvasChatMode): void;
  onCloseChat(): void;
  onOpenRegular(channelId: string): void;
  live: CanvasLive;
};

const SYNC_INTERVAL_MS = 5000;
const mostRecent = (canvases: Canvas[]) => canvases.reduce<Canvas | null>((best, c) => !best || c.updatedAt > best.updatedAt ? c : best, null);

/** Nudge goes through the normal send path as the signed-in human. */
async function sendNudge(channelId: string, agent: string) {
  await apiJson('/api/messages', {method: 'POST', headers: getApiHeaders(), body: JSON.stringify(nudgeMessage(channelId, agent))});
}

export function CanvasView({canvasId, humanId, onSelectCanvas, onMenu, live}: CanvasViewProps) {
  const store = useMemo(() => createBoardStore({api: boardApi, now: Date.now, intervalMs: SYNC_INTERVAL_MS}), []);
  const state = useSyncExternalStore(store.subscribe, store.snapshot);
  const [canvases, setCanvases] = useState<Canvas[] | null>(null);
  const [listFailed, setListFailed] = useState(false);
  const [listAttempt, setListAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    setListFailed(false);
    listCanvases().then(list => { if (current) setCanvases(list); }).catch(() => { if (current) setListFailed(true); });
    return () => { current = false; };
  }, [canvasId, listAttempt]);

  // Without a canvas in the URL, open the most recently updated one in place of this entry.
  useEffect(() => {
    if (canvasId || !canvases) return;
    const recent = mostRecent(canvases);
    if (recent) onSelectCanvas(recent.id, {replace: true});
  }, [canvasId, canvases]);

  useEffect(() => {
    if (!canvasId) return;
    void store.open(canvasId);
    store.start();
    return () => store.stop();
  }, [canvasId, store]);

  const board = state.canvasId === canvasId ? state.board : null;
  const pulses = useSyncExternalStore(live.subscribe, live.snapshot);
  // Live state refreshes only while the canvas view is mounted.
  useEffect(() => { live.start(); return () => live.stop(); }, [live]);
  const cards = board?.cards;
  useEffect(() => {
    live.setCards((cards ?? []).flatMap(card => card.access === 'open'
      ? [{channelId: card.channelId, agentNames: card.participants.filter(p => p.subscriberType === 'AGENT').map(p => p.subscriberId)}] : []));
  }, [cards, live]);
  const name = board?.canvas.name ?? canvases?.find(c => c.id === canvasId)?.name ?? '';
  let body: ReactNode;
  if (!canvasId) {
    body = listFailed ? <CanvasMessage text="Could not load your canvases." action="Try again" onAction={() => setListAttempt(n => n + 1)}/>
      : canvases && !canvases.length ? <FirstCanvas onCreated={id => onSelectCanvas(id, {replace: true})}/>
      : <CanvasMessage text="Loading canvases…"/>;
  } else if (state.status === 'gone' && state.canvasId === canvasId) {
    body = <CanvasMessage text="This canvas is not available. It may have been deleted, or it is no longer shared with you." action="Open another canvas" onAction={() => onSelectCanvas(null)}/>;
  } else if (state.status === 'error' && state.canvasId === canvasId) {
    body = <CanvasMessage text="Could not load this canvas." action="Try again" onAction={() => void store.open(canvasId)}/>;
  } else if (!board) {
    body = <CanvasMessage text="Loading canvas…"/>;
  } else {
    // Keyed by canvas so the saved view, gestures and measured card heights start fresh per canvas.
    body = <Surface key={board.canvas.id} board={board} humanId={humanId} onApply={store.apply} pulses={pulses} onNudge={sendNudge}/>;
  }

  return <section className="canvas-view" aria-label="Canvas">
    <WorkspaceTopbar onMenu={onMenu} leading={canvasId ? <div className="canvas-heading">
      <h1 className="canvas-name">{name}</h1>
      <CanvasSwitcher canvases={canvases ?? []} currentId={canvasId} onSelect={id => onSelectCanvas(id)}/>
    </div> : undefined}/>
    <div className="canvas-body">
      {state.notice && state.canvasId === canvasId ? <div className="canvas-notice" role="status">
        <span>{state.notice}</span>
        <button type="button" onClick={store.clearNotice}>Dismiss</button>
      </div> : null}
      {body}
    </div>
  </section>;
}

/** Placeholder switcher: lists the person's other canvases. A later task replaces it with the full menu. */
function CanvasSwitcher({canvases, currentId, onSelect}: {canvases: Canvas[]; currentId: string; onSelect(id: string): void}) {
  if (canvases.length < 2) return null;
  return <select className="canvas-switcher" aria-label="Switch canvas" value={currentId} onChange={event => onSelect(event.target.value)}>
    {canvases.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
  </select>;
}

function CanvasMessage({text, action, onAction}: {text: string; action?: string; onAction?: () => void}) {
  return <div className="canvas-message">
    <p>{text}</p>
    {action && onAction ? <button type="button" className="canvas-button" onClick={onAction}>{action}</button> : null}
  </div>;
}

function FirstCanvas({onCreated}: {onCreated(id: string): void}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // The id survives a failed submit, so a retry after a lost response cannot create a second canvas.
  const [id, setId] = useState(() => crypto.randomUUID());
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true); setError('');
    try {
      const canvas = await createCanvas(name.trim(), id);
      onCreated(canvas.id);
    } catch (failure) {
      setError('Could not create the canvas. Try again.');
      // 409: that id already holds a canvas with another name; the next attempt needs a new one.
      if (failure instanceof ApiError && failure.status === 409) setId(crypto.randomUUID());
      setBusy(false);
    }
  }
  return <div className="canvas-first">
    <img className="canvas-first-character" src={`${import.meta.env.BASE_URL}design/avatars/moss.png`} alt="" aria-hidden="true"/>
    <h2>Create your first canvas</h2>
    <p>Lay out your chats on one board and see where each one stands.</p>
    <form onSubmit={submit}>
      <label>Canvas name<input value={name} maxLength={120} placeholder="Launch" onChange={event => setName(event.target.value)} autoFocus/></label>
      <button type="submit" className="canvas-button" disabled={!name.trim() || busy}>{busy ? 'Creating…' : 'Create canvas'}</button>
    </form>
    {error ? <p className="canvas-error" role="alert">{error}</p> : null}
  </div>;
}
