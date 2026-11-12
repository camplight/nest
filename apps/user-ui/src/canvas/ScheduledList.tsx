// Scheduled jobs on the canvas: the clock icon (the mock's IC_CLOCK), a card's badge (schedBadge), the open chat's strips
// (schedStrip) and the top bar's list (renderSchedList): every job in the viewer's chats on this canvas or loose, grouped
// Missed, Starts when something happens, Next 24 hours, Later and Paused. A row opens its chat.
import {useEffect,useRef,useState} from 'react';
import {AgentAvatar} from '../components/AgentAvatar';
import {ClockIcon} from '../components/ClockIcon';
import {popStyle,usePopDismiss,usePopPlacement} from './HandoffPopover';
import {agentMadeCount,badgeOf,listGroups,rowWhen,stripState,type ListFilter,type ScheduleJob} from './schedule-jobs';

/** The mock's IC_CLOCK, shared with the bottom box's typed-repeat chip. */
export {ClockIcon};

/** A card's badge, under its last activity: `missed`, the first job's short rule, or a paused one greyed; `+N` for more. */
export function scheduleBadge(jobs: readonly ScheduleJob[] | undefined) {
  const badge = jobs ? badgeOf(jobs) : null;
  if (!badge) return null;
  return <span className={`sch${badge.kind === 'on' ? '' : ` ${badge.kind}`}`} title={badge.title}><ClockIcon/>{badge.text}</span>;
}

/**
 * One job's strip in the open chat's Setup body: its rule (and a webhook's name), who does it, who set it up when that is
 * not the viewer, and when it runs next (or that it missed, with why; a webhook is `waiting for it` or `last run … ✓`).
 * Run now (schedules only) and Edit follow the server's rights; an agent's own run has neither.
 */
export function scheduleStrip(job: ScheduleJob, {now, canRun, onRunNow, onEdit}: {
  now: number; canRun: boolean; onRunNow(job: ScheduleJob): Promise<void>; onEdit?(job: ScheduleJob, anchor: HTMLElement): void;
}) {
  const s = job.schedule, own = s ?? job.trigger;
  return <div key={job.key} className={`sch-strip${job.missed ? ' missed' : ''}`} data-schedule-id={s?.id} data-trigger-id={job.trigger?.id}>
    <ClockIcon/>
    <span><b>{job.text}</b>{job.label ? ` · ${job.label}` : ''} · {job.agent}{job.setBy ? ` · set by ${job.setBy}` : ''} · {stripState(job, now)}
      {job.missed ? <> · <b className="sch-missed">missed {job.missed.at}: {job.missed.reason}</b></> : job.lastOk ? ` · last run ${job.lastOk} ✓` : ''}</span>
    {own && ((canRun && s) || onEdit) ? <span className="sp">
      {canRun && s ? <RunNow job={job} onRunNow={onRunNow}/> : null}
      {onEdit ? <button type="button" className="btn" aria-haspopup="dialog" onClick={event => onEdit(job, event.currentTarget)}>Edit</button> : null}
    </span> : null}
  </div>;
}

/** Busy until the run is posted. aria-disabled, not disabled: a disabled button drops focus to the page body. */
function RunNow({job, onRunNow}: {job: ScheduleJob; onRunNow(job: ScheduleJob): Promise<void>}) {
  const [busy, setBusy] = useState(false);
  return <button type="button" className="btn" aria-disabled={busy || undefined}
    onClick={() => { if (busy) return; setBusy(true); void onRunNow(job).finally(() => setBusy(false)); }}>Run now</button>;
}

export type ScheduledListProps = {
  canvasName: string;
  /** The viewer's jobs in chats on this canvas or loose. */
  jobs: readonly ScheduleJob[];
  /** Chat titles by id. */
  titles: ReadonlyMap<string, string>;
  /** Chats on this canvas; any other row says `loose chat`. */
  onCanvas: ReadonlySet<string>;
  /** The top-bar button: the list sits under it and focus returns there. */
  anchor: HTMLElement | null;
  now(): number;
  onGoto(channelId: string): void;
  onClose(): void;
};

export const LIST_HINT = 'Each run posts into its own chat. Agents can schedule follow-ups too; those say who set them.';
export const LIST_FOOT = 'To add one, open a chat and press the clock, or type “every Monday at 9 …” in the bottom box.';

export function ScheduledList({canvasName, jobs, titles, onCanvas, anchor, now, onGoto, onClose}: ScheduledListProps) {
  const [filter, setFilter] = useState<ListFilter>('all');
  const ref = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const anchorRef = useRef(anchor); anchorRef.current = anchor;
  /** Set when a row was pressed: the list closes into that chat, so focus goes there, not back to Scheduled. */
  const going = useRef(false);
  // Under the button (r.left - 80, r.bottom + 12), inside the window; Escape and a press outside close it.
  const place = usePopPlacement(ref, anchor, 80, 12);
  usePopDismiss(ref, anchorRef, onClose);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    heading.current?.focus({preventScroll: true});
    return () => {
      const view = ref.current?.closest<HTMLElement>('.canvas-view') ?? document;
      if (going.current) {
        // The chat focuses itself when it opens; one already open is focused here.
        requestAnimationFrame(() => {
          const active = document.activeElement;
          if (active && active !== document.body && active.isConnected) return;
          view.querySelector<HTMLElement>('.canvas-chat')?.focus({preventScroll: true});
        });
        return;
      }
      [anchorRef.current, previous, view.querySelector<HTMLElement>('.canvas-surface')].find(element => element?.isConnected)?.focus({preventScroll: true});
    };
  }, []);
  const at = now();
  const groups = listGroups(jobs, filter, at);
  return <div ref={ref} role="dialog" aria-label="Scheduled jobs" className={`canvas-flow-pop invite wide canvas-sched-list${place ? ' is-placed' : ''}`} style={popStyle(place)}>
    <div className="iv-h"><div><h2 ref={heading} tabIndex={-1}>Scheduled on {canvasName}</h2><small>{LIST_HINT}</small></div></div>
    <div className="optrow" role="group" aria-label="Show">
      <button type="button" className={`pick txt${filter === 'all' ? ' on' : ''}`} aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All {jobs.length}</button>
      <button type="button" className={`pick txt${filter === 'agents' ? ' on' : ''}`} aria-pressed={filter === 'agents'} onClick={() => setFilter('agents')}>Set by agents {agentMadeCount(jobs)}</button>
    </div>
    <div className="slist">
      {groups.map(group => <section key={group.title} aria-label={group.title}>
        <div className="grp" aria-hidden="true">{group.title}</div>
        {group.jobs.map(job => {
          const [when, sub] = rowWhen(job, at);
          return <button key={job.key} type="button" className={`srow${job.missed ? ' missed' : ''}`} data-channel-id={job.channelId} onClick={() => { going.current = true; onGoto(job.channelId); }}>
            <AgentAvatar name={job.agent} size={28}/>
            <span className="srow-main">{titles.get(job.channelId) ?? 'Untitled chat'}
              <span className="sm2">{job.text}{job.label ? ` · ${job.label}` : ''}{job.setBy ? ` · set by ${job.setBy}` : ''}{onCanvas.has(job.channelId) ? '' : ' · loose chat'}</span></span>
            <span className="when"><b>{when}</b>{sub}</span>
          </button>;
        })}
      </section>)}
    </div>
    <div className="iv-foot"><span className="calm">{LIST_FOOT}</span><button type="button" className="btn pri" onClick={onClose}>Done</button></div>
  </div>;
}
