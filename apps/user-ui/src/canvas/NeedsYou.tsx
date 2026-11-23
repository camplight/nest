// Top-bar "Needs you (N)": unread mentions, project reviews and flow items (approvals, paused links, missed runs) on chats
// the person can see, with jump-to. A missed run's row has Run now.
import {useEffect,useMemo,useRef,useState} from 'react';
import type {DashboardTask,FlowNeed,Project,ProjectDashboard} from '@nest/schemas';
import {apiJson} from '../api';
import {ago} from './Card';
import {RunNowButton} from './ChatDigest';
import {needsYouItems,type NeedsItem} from './needs';
import type {CardPulse} from './pulse';

const REVIEWS_MS = 60_000;
const NO_REVIEWS: DashboardTask[] = [];

/**
 * Tasks awaiting review: read when enabled, when `open` turns true (a list opens; closing it reads nothing), on focus,
 * once a minute while visible, and when `reload` changes (after a review here). Nothing is read while `enabled` is false.
 */
export function useReviews(open: boolean, enabled = true, reload = 0) {
  const [reviews, setReviews] = useState<DashboardTask[]>(NO_REVIEWS);
  const read = useRef<() => void>(() => {});
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    const load = () => {
      apiJson<ProjectDashboard>('/api/projects/dashboard')
        .then(result => { if (current && Array.isArray(result.reviews)) setReviews(result.reviews); })
        .catch(() => {});
    };
    const tick = () => { if (document.visibilityState !== 'hidden') load(); };
    load();
    read.current = load;
    const timer = setInterval(tick, REVIEWS_MS);
    window.addEventListener('focus', load);
    return () => { current = false; read.current = () => {}; clearInterval(timer); window.removeEventListener('focus', load); };
  }, [enabled]);
  const wasOpen = useRef(open);
  useEffect(() => {
    if (open && !wasOpen.current) read.current();
    wasOpen.current = open;
  }, [open]);
  const lastReload = useRef(reload);
  useEffect(() => {
    if (reload !== lastReload.current) read.current();
    lastReload.current = reload;
  }, [reload]);
  return reviews;
}

export type NeedsYouProps = {
  pulses: ReadonlyMap<string, CardPulse>;
  /** The chats the person can see (open cards and loose chats) with their titles. */
  titles: ReadonlyMap<string, string>;
  projects: Project[];
  /** Tasks awaiting review, from the canvas's useReviews (cards show them too). */
  reviews: DashboardTask[];
  /** The viewer's flow items (useFlows). */
  flows: readonly FlowNeed[];
  /** Run now on a missed run's row. */
  onRunNow(item: NeedsItem): Promise<void>;
  /** The list opened or closed: the owner re-reads the reviews on open. */
  onOpenChange?(open: boolean): void;
  onJump(channelId: string): void;
};

export function NeedsYou({pulses, titles, projects, reviews, flows, onRunNow, onOpenChange, onJump}: NeedsYouProps) {
  const [open, setOpen] = useState(false);
  const changeRef = useRef(onOpenChange); changeRef.current = onOpenChange;
  useEffect(() => { changeRef.current?.(open); }, [open]);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const items = useMemo(() => needsYouItems({pulses, titles, reviews, projects, flows}), [pulses, titles, reviews, projects, flows]);
  // Ages move by the minute.
  const [now, setNow] = useState(Date.now);
  useEffect(() => { if (open) setNow(Date.now()); }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('[aria-modal="true"]:not(.canvas-chat)')) return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus({preventScroll: true});
    };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', key); };
  }, [open]);

  return <div className="canvas-needs-root" ref={root}>
    <button ref={trigger} type="button" className="canvas-needs" aria-haspopup="true" aria-expanded={open} aria-controls="canvas-needs-list"
      data-attention={items.length > 0 || undefined} aria-label={`Needs you (${items.length})`} onClick={() => setOpen(value => !value)}>
      {/* A narrow top bar keeps the dot and the count (canvas.css). */}
      <i className="canvas-needs-dot" aria-hidden="true"/><span className="canvas-bar-label">Needs you </span><span className="canvas-needs-count">({items.length})</span>
    </button>
    {open ? <div className="canvas-needs-panel" id="canvas-needs-list">
      {items.length ? <ul aria-label="Needs you">
        {items.map(item => <li key={item.key} className="canvas-needs-row">
          {item.canOpen ? <button type="button" className="canvas-needs-item" onClick={() => { setOpen(false); onJump(item.channelId); }}>
            <span className="canvas-needs-title">{item.chatTitle}</span>
            <span className="canvas-needs-detail">{item.detail}</span>
            <span className="canvas-needs-age">{ago(item.at, now)}</span>
          </button> : <div className="canvas-needs-item" data-inert="true">
            {/* A chat the person can no longer open: the row says what stopped, with nothing to jump to. */}
            <span className="canvas-needs-title">{item.chatTitle}</span>
            <span className="canvas-needs-detail">{item.detail}</span>
            <span className="canvas-needs-age">{ago(item.at, now)}</span>
          </div>}
          {item.gate?.kind === 'missed' ? <RunNowButton item={item} onRunNow={onRunNow} className="canvas-needs-run" named/> : null}
        </li>)}
      </ul> : <p className="canvas-needs-empty">Nothing needs you right now.</p>}
    </div> : null}
  </div>;
}
