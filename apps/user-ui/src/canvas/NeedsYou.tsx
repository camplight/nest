// Top-bar "Needs you (N)": unread mentions and project reviews on chats the person can see, with jump-to.
import {useEffect,useMemo,useRef,useState} from 'react';
import type {DashboardTask,Project,ProjectDashboard} from '@nest/schemas';
import {apiJson} from '../api';
import {ago} from './Card';
import {needsYouItems} from './needs';
import type {CardPulse} from './pulse';

const REVIEWS_MS = 60_000;
const NO_REVIEWS: DashboardTask[] = [];

/** Tasks awaiting review: read on mount, when the list opens, on focus, and once a minute while visible. */
export function useReviews(open: boolean) {
  const [reviews, setReviews] = useState<DashboardTask[]>(NO_REVIEWS);
  useEffect(() => {
    let current = true;
    const load = () => {
      apiJson<ProjectDashboard>('/api/projects/dashboard')
        .then(result => { if (current && Array.isArray(result.reviews)) setReviews(result.reviews); })
        .catch(() => {});
    };
    const tick = () => { if (document.visibilityState !== 'hidden') load(); };
    load();
    const timer = setInterval(tick, REVIEWS_MS);
    window.addEventListener('focus', load);
    return () => { current = false; clearInterval(timer); window.removeEventListener('focus', load); };
  }, [open]);
  return reviews;
}

export type NeedsYouProps = {
  pulses: ReadonlyMap<string, CardPulse>;
  /** The chats the person can see (open cards and loose chats) with their titles. */
  titles: ReadonlyMap<string, string>;
  projects: Project[];
  onJump(channelId: string): void;
};

export function NeedsYou({pulses, titles, projects, onJump}: NeedsYouProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const reviews = useReviews(open);
  const items = useMemo(() => needsYouItems({pulses, titles, reviews, projects}), [pulses, titles, reviews, projects]);
  // Ages move by the minute.
  const [now, setNow] = useState(Date.now);
  useEffect(() => { if (open) setNow(Date.now()); }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('[aria-modal="true"]')) return;
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
      data-attention={items.length > 0 || undefined} onClick={() => setOpen(value => !value)}>Needs you ({items.length})</button>
    {open ? <div className="canvas-needs-panel" id="canvas-needs-list">
      {items.length ? <ul aria-label="Needs you">
        {items.map(item => <li key={item.key}>
          <button type="button" className="canvas-needs-item" onClick={() => { setOpen(false); onJump(item.channelId); }}>
            <span className="canvas-needs-title">{item.chatTitle}</span>
            <span className="canvas-needs-detail">{item.detail}</span>
            <span className="canvas-needs-age">{ago(item.at, now)}</span>
          </button>
        </li>)}
      </ul> : <p className="canvas-needs-empty">Nothing needs you right now.</p>}
    </div> : null}
  </div>;
}
