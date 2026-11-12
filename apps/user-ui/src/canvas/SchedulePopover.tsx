// The clock popover (the mock's renderSchedPop): what should happen, who does it and when, with a plain-language summary
// and the next run in the schedule's time zone. Anchored under the button that opened it (the mock's popAt, 200 px left
// and 8 px down) and kept inside the window. A new schedule is saved by `Schedule it`; an existing one by `Save`, and it
// can also be paused or deleted. Only its creator changes what, who and when; a member of the chat may pause or delete it.
// The mock's `Webhook` kind arrives with the webhook form (T11-R1); app events are not offered (mockup deviation 1).
import {useEffect,useMemo,useRef,useState} from 'react';
import {DAYS,atText,nextRunAt,relTime,ruleText,type ScheduleRule,type ScheduleView} from '@nest/schemas';
import {AgentAvatar} from '../components/AgentAvatar';
import {popStyle,usePopDismiss,usePopPlacement} from './HandoffPopover';

type Kind = ScheduleRule['kind'];
export const KINDS: [Kind, string][] = [['once', 'Once'], ['daily', 'Every day'], ['weekdays', 'Weekdays'], ['weekly', 'Every week'], ['monthly', 'Every month'], ['interval', 'Every few minutes']];
const MINUTES = [5, 15, 30, 60];
export const SCHEDULE_HINT = 'Every run happens in this chat, so results stay in one thread, and chats connected to it get them too.';

/** Every field any kind uses (the mock's sj-kind keeps them all), so switching kinds and back loses nothing. */
type Draft = {kind: Kind; time: string; days: number[]; day: number; mins: number; dom: number};
/** What a save sends: the schedule's agent, prompt and rule. */
export type ScheduleDraft = {agent: string; prompt: string; rule: ScheduleRule};

const today = () => (new Date().getDay() + 6) % 7;
function draftOf(rule: ScheduleRule | null): Draft {
  const base: Draft = {kind: 'weekly', time: '09:00', days: [0], day: today(), mins: 15, dom: 1};
  if (!rule) return base;
  return {...base, ...rule, ...(rule.kind === 'weekly' ? {days: [...rule.days]} : {})} as Draft;
}
/** The rule a draft describes; null while it cannot run (a week with no day picked, a time not set). */
export function ruleOf(d: Draft): ScheduleRule | null {
  if (d.kind !== 'interval' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(d.time)) return null;
  switch (d.kind) {
    case 'once': return {kind: 'once', day: d.day, time: d.time};
    case 'daily': return {kind: 'daily', time: d.time};
    case 'weekdays': return {kind: 'weekdays', time: d.time};
    case 'weekly': return d.days.length ? {kind: 'weekly', days: [...d.days].sort((a, b) => a - b), time: d.time} : null;
    case 'monthly': return {kind: 'monthly', dom: d.dom, time: d.time};
    case 'interval': return {kind: 'interval', mins: d.mins};
  }
}
/** The mock's summary text for the prompt: first letter lower, no final period; `do this` while empty. */
export const willDo = (prompt: string) => (prompt.trim() || 'do this').replace(/^./, m => m.toLowerCase()).replace(/\.$/, '');

export type SchedulePopoverProps = {
  chat: {channelId: string; title: string};
  /** The schedule being edited; null for a new one. */
  schedule: ScheduleView | null;
  /** The chat's agents (never the service agent). */
  agents: readonly string[];
  /** The person's pinned agents, offered too: one not in the chat joins it on save. */
  pinned: readonly string[];
  /** The browser's time zone, sent with a new schedule. An existing one keeps its own. */
  timezone: string;
  /** The button the popover sits under; focus returns there on close. */
  anchor: HTMLElement | null;
  now(): number;
  /** Saves; resolves true once saved (the canvas then closes the popover and says so). */
  onSave(draft: ScheduleDraft): Promise<boolean>;
  /** Pause or Resume (the creator or a chat member: `canManage`). */
  onPause?(on: boolean): Promise<void>;
  onDelete?(): Promise<void>;
  onClose(): void;
};

export function SchedulePopover({chat, schedule, agents, pinned, timezone, anchor, now, onSave, onPause, onDelete, onClose}: SchedulePopoverProps) {
  const editable = schedule ? schedule.canEdit : true;
  const tz = schedule?.timezone ?? timezone;
  const [prompt, setPrompt] = useState(schedule?.prompt ?? '');
  const choices = useMemo(() => [...new Set([...(schedule ? [schedule.agent] : []), ...agents, ...pinned])], [schedule, agents, pinned]);
  const [agent, setAgent] = useState(() => schedule?.agent ?? agents[0] ?? pinned[0] ?? '');
  const [draft, setDraft] = useState(() => draftOf(schedule?.rule ?? null));
  const [busy, setBusy] = useState(false);
  const rule = ruleOf(draft);
  const set = (patch: Partial<Draft>) => setDraft(current => ({...current, ...patch}));
  const kind = (k: Kind) => set({kind: k});

  // Focus moves to the heading; on close it returns to the opener, else to what was focused before.
  const ref = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const anchorRef = useRef(anchor); anchorRef.current = anchor;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    heading.current?.focus({preventScroll: true});
    return () => {
      const view = ref.current?.closest<HTMLElement>('.canvas-view') ?? document;
      [anchorRef.current, previous, view.querySelector<HTMLElement>('.canvas-chat')].find(element => element?.isConnected)?.focus({preventScroll: true});
    };
  }, []);
  const place = usePopPlacement(ref, anchor, 200, 8);
  usePopDismiss(ref, anchorRef, onClose);

  const at = now();
  const next = rule ? nextRunAt(rule, tz, at) : null;
  // A week with no day reads as the mock's `Every … at 09:00` while the person picks one.
  const text = rule ? ruleText(rule) : draft.kind === 'weekly' ? `Every … at ${draft.time}` : ruleText({...draft, kind: draft.kind} as ScheduleRule);
  const ready = editable && Boolean(rule && agent && prompt.trim() && next !== null);
  const save = () => {
    if (!ready || busy || !rule) return;
    setBusy(true);
    void onSave({agent, prompt: prompt.trim(), rule}).finally(() => setBusy(false));
  };
  const act = (run: () => Promise<void>) => { if (busy) return; setBusy(true); void run().finally(() => setBusy(false)); };
  const id = schedule?.id ?? 'new';

  return <div ref={ref} role="dialog" aria-label={schedule ? 'Edit schedule' : 'Schedule'} className={`canvas-flow-pop invite wide canvas-sched-pop${place ? ' is-placed' : ''}`} style={popStyle(place)}>
    <div className="iv-h"><div><h2 ref={heading} tabIndex={-1}>{schedule ? 'Edit schedule' : 'Schedule'} · {chat.title.slice(0, 32)}</h2><small>{SCHEDULE_HINT}</small></div></div>
    <label className="iv-l" htmlFor={`sj-what-${id}`}>What should happen</label>
    <textarea className="iv-in" id={`sj-what-${id}`} rows={2} placeholder="e.g. Check for new episodes and start the flow" value={prompt} maxLength={4000}
      readOnly={!editable} onChange={event => setPrompt(event.target.value)}/>
    <div className="iv-l" id={`sj-who-${id}`}>Who does it</div>
    <div className="optrow" role="group" aria-labelledby={`sj-who-${id}`}>
      {choices.map(name => <button key={name} type="button" className={`pick${agent === name ? ' on' : ''}`} aria-pressed={agent === name} disabled={!editable}
        onClick={() => setAgent(name)}><AgentAvatar name={name} size={20}/>{name}</button>)}
      {choices.length ? null : <span className="calm">Add an agent to this chat first.</span>}
    </div>
    <div className="iv-l" id={`sj-when-${id}`}>When</div>
    <div className="optrow" role="group" aria-labelledby={`sj-when-${id}`}>
      {KINDS.map(([k, label]) => <button key={k} type="button" className={`pick txt${draft.kind === k ? ' on' : ''}`} aria-pressed={draft.kind === k} disabled={!editable}
        onClick={() => kind(k)}>{label}</button>)}
    </div>
    <div className="sched-when">
      {draft.kind === 'weekly' ? <div className="days" role="group" aria-label="Days">{DAYS.map((d, i) => <button key={d} type="button" className={draft.days.includes(i) ? 'on' : ''}
        aria-pressed={draft.days.includes(i)} disabled={!editable}
        onClick={() => set({days: draft.days.includes(i) ? draft.days.filter(x => x !== i) : [...draft.days, i].sort((a, b) => a - b)})}>{d}</button>)}</div> : null}
      {draft.kind === 'once' ? <div className="days" role="group" aria-label="Day">{DAYS.map((d, i) => <button key={d} type="button" className={draft.day === i ? 'on' : ''}
        aria-pressed={draft.day === i} disabled={!editable} onClick={() => set({day: i})}>{d}</button>)}</div> : null}
      {draft.kind === 'interval'
        ? <select className="iv-in" aria-label="How often" value={draft.mins} disabled={!editable} onChange={event => set({mins: Number(event.target.value)})}>
          {[...new Set([...MINUTES, draft.mins])].sort((a, b) => a - b).map(m => <option key={m} value={m}>every {m} min</option>)}
        </select>
        : <input className="iv-in" type="time" aria-label="Time" value={draft.time} readOnly={!editable} onChange={event => set({time: event.target.value})}/>}
    </div>
    <div className="lk-sum" role="status">
      <b>{agent || 'someone'}</b> will {willDo(prompt)} · <b>{text}</b>.{next !== null ? ` Next run: ${atText(next, tz)} (${relTime(next, at)}).` : ''} If a run can't start, it shows up in Needs you. Times are in {tz}.
    </div>
    <div className="iv-foot">
      {schedule && onDelete ? <button type="button" className="btn" style={{marginRight: 'auto'}} aria-disabled={busy || undefined} onClick={() => act(onDelete)}>Delete</button> : null}
      {schedule && onPause ? <button type="button" className="btn" aria-disabled={busy || undefined} onClick={() => act(() => onPause(!schedule.on))}>{schedule.on ? 'Pause' : 'Resume'}</button> : null}
      {editable ? <>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn pri" aria-disabled={!ready || busy || undefined} onClick={save}>{schedule ? 'Save' : 'Schedule it'}</button>
      </> : <button type="button" className="btn pri" onClick={onClose}>Done</button>}
    </div>
  </div>;
}
