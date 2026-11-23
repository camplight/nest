// A chat window on the desktop canvas that is not the active one: its own live thread, read-only, and "Click to reply"
// where the message box would be. A press in it (or Enter or Space on the window itself) makes it the active window, which brings the box there.
import {memo,useCallback,useRef,type CSSProperties,type DragEvent as ReactDragEvent,type ReactNode} from 'react';
import {X} from 'lucide-react';
import type {Agent} from '../types';
import type {ChannelEventsCore,ChannelEventsSnapshot} from '../chat/channel-events';
import {ChatThread} from '../chat/ChatThread';
import {ChatHeaderSlotsContext,type ChatHeaderSlots} from '../chat/header-slots';
import {isTraceEvent} from '../chat/timeline';
import {useChannelEvents} from '../chat/useChannelEvents';
import {AgentAvatar} from '../components/AgentAvatar';
import {dragCarriesFiles,droppedFiles} from '../components/file-drop';
import type {Point} from './geometry';
import type {Bounds} from './sheet';
import {windowVars,type ChatWindow} from './chat-windows';
import {useWindowDrag} from './useWindowDrag';

/** Who is in a chat, for its header's faces. `service`: the Switchyard agent, which posts hand-offs and never replies. */
export type ChatPerson = {agent: boolean; name: string; service?: boolean};
/** Slots that go nowhere: a passive thread has no Huddle, Sharing or Export (they belong to the active chat). */
const NO_SLOTS: ChatHeaderSlots = {actions: null, more: null};
const MAX_FACES = 5;
const initials = (name: string) => name.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean).slice(0, 2).map(word => word[0]).join('').toUpperCase() || '?';

/** The mock's `.ch-sub` faces: up to five participants, then `+N`. */
export function ChatFaces({people}: {people: readonly ChatPerson[]}) {
  if (!people.length) return null;
  const shown = people.slice(0, MAX_FACES), more = people.length - shown.length;
  return <span className="canvas-chat-faces" role="img" aria-label={`In this chat: ${people.map(p => p.name).join(', ')}`}>
    {shown.map(person => person.agent
      ? <span key={`a:${person.name}`} className="canvas-chat-face" title={person.service ? `${person.name} · posts hand-offs and scheduled runs; never replies` : person.name}><AgentAvatar name={person.name} size={20}/></span>
      : <span key={`h:${person.name}`} className="canvas-chat-face is-human" title={person.name} aria-hidden="true">{initials(person.name)}</span>)}
    {more ? <span className="canvas-chat-face is-more" aria-hidden="true">+{more}</span> : null}
  </span>;
}

/** Files dragged onto a window: taken by it (never the bottom box behind), handed over with whether folders were left out. */
export function windowFileDrop(onFiles: (files: File[], folders: boolean) => void) {
  return {
    onDragOver(event: ReactDragEvent<HTMLElement>) {
      if (!dragCarriesFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    },
    onDrop(event: ReactDragEvent<HTMLElement>) {
      if (!dragCarriesFiles(event.dataTransfer)) return;
      event.preventDefault();
      const {files, folders} = droppedFiles(event.dataTransfer);
      onFiles(files, folders);
    },
  };
}

/** No message or agent activity yet, once loaded: the same test App makes for its own thread. */
export const conversationEmpty = (snapshot: ChannelEventsSnapshot) =>
  !snapshot.loading && !snapshot.events.some(event => event.type === 'message.created' || isTraceEvent(event));

/**
 * A window's thread from its own core: read-only, so quoting, a message link or a demo preview just activate the window.
 * Memoised: it re-renders for its own events, not for every canvas render.
 */
export const PassiveThread = memo(function PassiveThread({core, username, agents, title, onActivate}: {
  core: ChannelEventsCore; username: string; agents: Agent[]; title: string; onActivate(): void;
}) {
  const snapshot = useChannelEvents(core);
  return <div className="canvas-chat-passive" data-passive-thread="">
    <ChatHeaderSlotsContext.Provider value={NO_SLOTS}>
      <ChatThread snapshot={snapshot} core={core} currentUsername={username} agents={agents} focusedMessageId={null} isConversationEmpty={conversationEmpty(snapshot)}
        channelLabel={title} appActivity onPreviewDemo={onActivate} onQuote={onActivate} onFocusMessage={onActivate}/>
    </ChatHeaderSlotsContext.Provider>
  </div>;
});

/**
 * The active window's body: App's chat (thread and message box) once App's events are for this chat and loaded, and this
 * window's own thread until then, so activating a window never shows a blank or loading thread.
 */
export function ActiveWindowBody({ready, passive, children}: {ready: boolean; passive: ReactNode; children: ReactNode}) {
  return <>{ready ? children : passive}</>;
}

/**
 * Keyboard activation: Enter or Space while the window itself is focused (it is in the Tab order), never on focus and
 * never from something inside it. Activating as Tab passes through would swap the DOM order and bounce the keyboard.
 */
export function passiveActivation(onActivate: () => void) {
  return {
    onKeyDown(event: {target: EventTarget; currentTarget: EventTarget; key: string; preventDefault(): void}) {
      if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault();
      onActivate();
    },
  };
}

/**
 * Whether a press at (clientX, clientY) on `element` hits its own scrollbar rather than its content: outside its client
 * box (which leaves the scrollbars out) while it has something to scroll. Such a press scrolls the thread; activating
 * the window then would swap the thread and lose the scroll drag.
 */
export function pressOnScrollbar(element: {
  clientLeft: number; clientTop: number; clientWidth: number; clientHeight: number; scrollWidth: number; scrollHeight: number;
  getBoundingClientRect(): {left: number; top: number};
}, clientX: number, clientY: number): boolean {
  if (element.scrollHeight <= element.clientHeight && element.scrollWidth <= element.clientWidth) return false;
  const box = element.getBoundingClientRect();
  const x = clientX - box.left - element.clientLeft, y = clientY - box.top - element.clientTop;
  return x < 0 || y < 0 || x >= element.clientWidth || y >= element.clientHeight;
}

/**
 * A passive window: title, faces and Close over its live thread. Not modal; it is in the Tab order, and Tabbing through
 * it does not activate it. The header drags it: the drag brings it to the front at once and activates it on release, so
 * the drag is not lost to the swap.
 */
export function PassiveWindow({win, bounds, zIndex, title, people, core, username, agents, onActivate, onRaise, onClose, onMove, onFiles}: {
  win: ChatWindow; bounds: Bounds; zIndex: number; title: string; people: readonly ChatPerson[];
  core: ChannelEventsCore; username: string; agents: Agent[];
  onActivate(): void; onClose(): void; onMove(at: Point): void;
  /** A header drag started: the window comes to the front (z-order only; it becomes active on release). */
  onRaise?(): void;
  /** Files dropped on the window: they go to this chat, which becomes active. */
  onFiles?(files: File[], folders: boolean): void;
}) {
  const panel = useRef<HTMLElement>(null);
  const header = useRef<HTMLElement>(null);
  // One activate for the thread across renders, so its memo holds.
  const activateRef = useRef(onActivate); activateRef.current = onActivate;
  const activate = useCallback(() => activateRef.current(), []);
  const drag = useWindowDrag({win, bounds, panel, onMove, onStart: onRaise, onEnd: activate});
  const keys = passiveActivation(onActivate);
  const drop = onFiles ? windowFileDrop(onFiles) : undefined;
  return <section ref={panel} className="canvas-chat is-passive" data-mode="focus" data-window="true" data-channel-id={win.channelId}
    role="dialog" aria-label={`Chat ${title}`} tabIndex={0} style={{...windowVars(drag.win ?? win, bounds), zIndex} as CSSProperties}
    onPointerDown={event => {
      // Close closes; a press on the header drags and activates on release; one on the thread's scrollbar scrolls; anywhere
      // else activates now.
      const target = event.target;
      if (target instanceof Element && (target.closest('.canvas-chat-close') || (event.button === 0 && header.current?.contains(target)))) return;
      if (target instanceof HTMLElement && pressOnScrollbar(target, event.clientX, event.clientY)) return;
      onActivate();
    }}
    onKeyDown={keys.onKeyDown}
    onDragOver={drop?.onDragOver} onDrop={drop?.onDrop}>
    <header ref={header} className="canvas-chat-bar" {...drag.handlers}>
      <div className="canvas-chat-heading">
        <h2 className="canvas-chat-title">{title}</h2>
        {people.length ? <p className="canvas-chat-sub"><ChatFaces people={people}/></p> : null}
      </div>
      <div className="canvas-chat-actions">
        <button type="button" className="canvas-chat-icon canvas-chat-close" aria-label={`Close chat ${title}`} title="Close" onClick={onClose}><X size={16} aria-hidden="true"/></button>
      </div>
    </header>
    <div className="canvas-chat-body"><PassiveThread core={core} username={username} agents={agents} title={title} onActivate={activate}/></div>
    <p className="canvas-chat-reply">Click to reply</p>
  </section>;
}
