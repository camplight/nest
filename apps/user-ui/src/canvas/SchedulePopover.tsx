// The clock popover (the mock's renderSchedPop): what should happen, who does it and when, with a plain-language summary
// and the next run in the schedule's time zone. Anchored under the button that opened it (the mock's popAt, 200 px left
// and 8 px down) and kept inside the window. A new schedule is saved by `Schedule it`; an existing one by `Save`, and it
// can also be paused or deleted. Only its creator changes what, who and when; a member of the chat may pause or delete it.
// The mock's `Webhook` kind (last in the When row) is a webhook trigger: a name (what calls it), then its URL, shown in
// full with Copy once (after create or Rotate URL) and masked afterwards. `App event` (after Webhook, only when flows report
// app events available) picks a connected app, one of its trigger types and that type's settings; it has no URL.
import {useEffect,useMemo,useRef,useState} from 'react';
import {DAYS,MAX_TRIGGER_LABEL,type AppTriggerType,atText,nextRunAt,relTime,ruleText,type ScheduleRule,type ScheduleView,type TriggerView} from '@nest/schemas';
import {flowError} from './flows-api';
import {AgentAvatar} from '../components/AgentAvatar';
import {popStyle,usePopDismiss,usePopPlacement} from './HandoffPopover';
import {AppTriggerFields} from './AppTriggerFields';
import {appEventName,configFields,configInitial,configValue,type ConfigValues} from './trigger-config';

type Kind = ScheduleRule['kind'] | 'webhook' | 'app';
export const KINDS: [ScheduleRule['kind'], string][] = [['once', 'Once'], ['daily', 'Every day'], ['weekdays', 'Weekdays'], ['weekly', 'Every week'], ['monthly', 'Every month'], ['interval', 'Every few minutes']];
/** The mock's last kind. */
export const WEBHOOK_KIND: ['webhook', string] = ['webhook', 'Webhook'];
/** The kind after Webhook, offered only when app events are available. */
export const APP_KIND: ['app', string] = ['app', 'App event'];
export const HOOK_ONCE = 'Copy it now. It is shown only once.';
/** The masked URL of a webhook whose full URL was shown already: only the token's last 4 characters are known. */
export const maskedHookUrl = (hint: string) => `…/api/hooks/nest_hook_••••${hint}`;
const MINUTES = [5, 15, 30, 60];
export const SCHEDULE_HINT = 'Every run happens in this chat, so results stay in one thread, and chats connected to it get them too.';

/** Every field any kind uses (the mock's sj-kind keeps them all), so switching kinds and back loses nothing. */
type Draft = {kind: Kind; time: string; days: number[]; day: number; mins: number; dom: number};
/** What a save sends: the schedule's agent, prompt and rule. */
export type ScheduleDraft = {agent: string; prompt: string; rule: ScheduleRule};
/** What a webhook's save sends: its agent, prompt and name. */
export type WebhookDraft = {agent: string; prompt: string; label: string};
/** What an app event's save sends: its agent, prompt, name, the app, its trigger type and that type's settings. */
export type AppDraft = WebhookDraft & {app: string; triggerSlug: string; config: Record<string, unknown>};

const today = () => (new Date().getDay() + 6) % 7;
function draftOf(rule: ScheduleRule | null): Draft {
  const base: Draft = {kind: 'weekly', time: '09:00', days: [0], day: today(), mins: 15, dom: 1};
  if (!rule) return base;
  return {...base, ...rule, ...(rule.kind === 'weekly' ? {days: [...rule.days]} : {})} as Draft;
}
/** The rule a draft describes; null while it cannot run (a week with no day picked, a time not set). */
export function ruleOf(d: Draft): ScheduleRule | null {
  if (d.kind === 'webhook' || d.kind === 'app') return null;
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
  /** The webhook being edited (or just made); null otherwise. */
  trigger?: TriggerView | null;
  /** Offer the Webhook kind for a new item (flows report webhooks available). */
  webhooks?: boolean;
  /** Offer the App event kind for a new item (flows report app events available). */
  appEvents?: boolean;
  /** The person's connected apps, and an app's trigger types (the popover reads them when App event is picked). */
  loadApps?(): Promise<string[]>;
  loadTypes?(app: string): Promise<AppTriggerType[]>;
  /** The webhook's full URL, right after it was made or rotated: shown once, with Copy. */
  url?: string | null;
  /** The chat's agents (never the service agent). */
  agents: readonly string[];
  /** The person's pinned agents, offered too: one not in the chat joins it on save. */
  pinned: readonly string[];
  /** The browser's time zone, sent with a new schedule. An existing one keeps its own. */
  timezone: string;
  /** The button the popover sits under; focus returns there on close. */
  anchor: HTMLElement | null;
  now(): number;
  /**
   * Saves; resolves true once saved (the canvas then closes the popover and says so). `opened` is the schedule as it was
   * when the popover opened, so only the fields the person changed are sent.
   */
  onSave(draft: ScheduleDraft, opened: ScheduleView | null): Promise<boolean>;
  /** Saves a webhook: a new one stays open with its URL; an edit closes. Resolves true once saved. */
  onSaveWebhook?(draft: WebhookDraft, opened: TriggerView | null): Promise<boolean>;
  /** Saves a new app event: resolves null once saved, else the reason, shown in the popover. */
  onSaveApp?(draft: AppDraft): Promise<string | null>;
  /** Rotate URL (the webhook's creator): the old URL stops working and the new one is shown once. */
  onRotate?(): Promise<void>;
  /** Pause or Resume (the creator or a chat member: `canManage`). */
  onPause?(on: boolean): Promise<void>;
  onDelete?(): Promise<void>;
  onClose(): void;
};

export function SchedulePopover({chat, schedule, trigger = null, webhooks = false, appEvents = false, loadApps, loadTypes, onSaveApp, url = null, agents, pinned, timezone, anchor, now, onSave, onSaveWebhook, onRotate, onPause, onDelete, onClose}: SchedulePopoverProps) {
  const item = schedule ?? trigger;
  // While a webhook's full URL is shown the footer is only Done, so the fields are read only: nothing typed is lost.
  const editable = (item ? item.canEdit : true) && !url;
  const tz = schedule?.timezone ?? timezone;
  const [prompt, setPrompt] = useState(item?.prompt ?? '');
  const [label, setLabel] = useState(trigger?.label ?? '');
  const choices = useMemo(() => [...new Set([...(item ? [item.agent] : []), ...agents, ...pinned])], [item, agents, pinned]);
  const [agent, setAgent] = useState(() => item?.agent ?? agents[0] ?? pinned[0] ?? '');
  const [draft, setDraft] = useState<Draft>(() => trigger ? {...draftOf(null), kind: trigger.kind === 'app' ? 'app' : 'webhook'} : draftOf(schedule?.rule ?? null));
  const [busy, setBusy] = useState(false);
  const opened = useRef(schedule);
  const openedTrigger = useRef(trigger);
  const hook = draft.kind === 'webhook';
  const appKind = draft.kind === 'app';
  const canApp = appEvents && Boolean(onSaveApp && loadApps && loadTypes);
  // An existing schedule stays a schedule, a webhook a webhook and an app event an app event; a new item offers every kind available.
  const kinds: [Kind, string][] = trigger ? [trigger.kind === 'app' ? APP_KIND : WEBHOOK_KIND]
    : schedule ? KINDS : [...KINDS, ...(webhooks && onSaveWebhook ? [WEBHOOK_KIND] : []), ...(canApp ? [APP_KIND] : [])];
  // A new app event: the connected apps, the chosen app's trigger types, and the chosen type's settings.
  const newApp = appKind && !trigger;
  const [apps, setApps] = useState<string[] | null>(null);
  const [app, setApp] = useState('');
  const [types, setTypes] = useState<AppTriggerType[] | null>(null);
  const [typesError, setTypesError] = useState<string | null>(null);
  const [slug, setSlug] = useState('');
  const [values, setValues] = useState<ConfigValues>({});
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!newApp || apps !== null || !loadApps) return;
    let live = true;
    loadApps().then(list => { if (live) setApps(list); }, () => { if (live) setApps([]); });
    return () => { live = false; };
  }, [newApp, apps, loadApps]);
  useEffect(() => {
    setTypes(null); setTypesError(null); setSlug(''); setValues({});
    if (!newApp || !app || !loadTypes) return;
    let live = true;
    loadTypes(app).then(list => { if (live) setTypes(list); }, error => { if (live) setTypesError(flowError(error, 'Could not read this app\'s events. Try again.')); });
    return () => { live = false; };
  }, [newApp, app, loadTypes]);
  const picked = types?.find(t => t.slug === slug);
  const fields = useMemo(() => picked ? configFields(picked.config) : [], [picked]);
  const pickSlug = (next: string) => {
    setSlug(next);
    setValues(configInitial(configFields(types?.find(t => t.slug === next)?.config)));
  };
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
      [anchorRef.current, previous, view.querySelector<HTMLElement>('.canvas-chat:not(.is-passive)')].find(element => element?.isConnected)?.focus({preventScroll: true});
    };
  }, []);
  const place = usePopPlacement(ref, anchor, 200, 8);
  usePopDismiss(ref, anchorRef, onClose);

  // The full URL appears once, after create or Rotate URL: focus goes to it, selected, ready to copy.
  const urlRef = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setCopied(false);
    if (url) { urlRef.current?.focus({preventScroll: true}); urlRef.current?.select(); }
  }, [url]);
  const copy = () => {
    urlRef.current?.select();
    if (!url) return;
    void navigator.clipboard?.writeText(url).then(() => setCopied(true), () => undefined);
  };

  const at = now();
  const next = rule ? nextRunAt(rule, tz, at) : null;
  // A week with no day reads as the mock's `Every … at 09:00` while the person picks one.
  const text = hook ? ruleText({kind: 'webhook'}) : appKind ? ruleText({kind: 'app'}) : rule ? ruleText(rule) : draft.kind === 'weekly' ? `Every … at ${draft.time}` : ruleText({...draft, kind: draft.kind} as ScheduleRule);
  const ready = editable && (newApp
    ? Boolean(agent && prompt.trim() && app && slug)
    : hook || appKind
    ? Boolean(onSaveWebhook && agent && prompt.trim() && label.trim())
    : Boolean(rule && agent && prompt.trim() && next !== null));
  const save = () => {
    if (!ready || busy) return;
    if (newApp) {
      const {config, problems} = configValue(fields, values);
      if (problems.length) { setProblem(problems[0]); return; }
      setProblem(null);
      setBusy(true);
      void onSaveApp!({agent, prompt: prompt.trim(), label: label.trim() || `${app} ${appEventName(app, slug)}`.slice(0, MAX_TRIGGER_LABEL), app, triggerSlug: slug, config}).then(error => setProblem(error)).finally(() => setBusy(false));
      return;
    }
    if (hook || appKind) {
      setBusy(true);
      void onSaveWebhook!({agent, prompt: prompt.trim(), label: label.trim()}, openedTrigger.current).finally(() => setBusy(false));
      return;
    }
    if (!rule) return;
    setBusy(true);
    void onSave({agent, prompt: prompt.trim(), rule}, opened.current).finally(() => setBusy(false));
  };
  const act = (run: () => Promise<void>) => { if (busy) return; setBusy(true); void run().finally(() => setBusy(false)); };
  const id = item?.id ?? 'new';

  return <div ref={ref} role="dialog" aria-label={item ? 'Edit schedule' : 'Schedule'} className={`canvas-flow-pop invite wide canvas-sched-pop${place ? ' is-placed' : ''}`} style={popStyle(place)}>
    <div className="iv-h"><div><h2 ref={heading} tabIndex={-1}>{item ? 'Edit schedule' : 'Schedule'} · {chat.title.slice(0, 32)}</h2><small>{SCHEDULE_HINT}</small></div></div>
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
      {kinds.map(([k, name]) => <button key={k} type="button" className={`pick txt${draft.kind === k ? ' on' : ''}`} aria-pressed={draft.kind === k} disabled={!editable}
        onClick={() => kind(k)}>{name}</button>)}
    </div>
    <div className="sched-when">
      {draft.kind === 'weekly' ? <div className="days" role="group" aria-label="Days">{DAYS.map((d, i) => <button key={d} type="button" className={draft.days.includes(i) ? 'on' : ''}
        aria-pressed={draft.days.includes(i)} disabled={!editable}
        onClick={() => set({days: draft.days.includes(i) ? draft.days.filter(x => x !== i) : [...draft.days, i].sort((a, b) => a - b)})}>{d}</button>)}</div> : null}
      {draft.kind === 'once' ? <div className="days" role="group" aria-label="Day">{DAYS.map((d, i) => <button key={d} type="button" className={draft.day === i ? 'on' : ''}
        aria-pressed={draft.day === i} disabled={!editable} onClick={() => set({day: i})}>{d}</button>)}</div> : null}
      {hook || appKind ? <>
        <input className="iv-in sched-hook-name" aria-label="Name" placeholder={appKind ? 'Name, e.g. New pull requests' : 'What calls it, e.g. Sentry'} value={label} maxLength={MAX_TRIGGER_LABEL}
          readOnly={!editable} onChange={event => setLabel(event.target.value)}/>
        {appKind ? trigger ? <span className="calm">{trigger.app} · {appEventName(trigger.app ?? '', trigger.triggerSlug ?? '')}</span>
          : <AppTriggerFields apps={apps} app={app} types={types} typesError={typesError} slug={slug} values={values} disabled={!editable}
            onApp={setApp} onSlug={pickSlug} onValues={setValues}/> : null}
        {appKind ? null : url ? <>
          <input ref={urlRef} className="iv-in sched-hook-url" readOnly aria-label="Webhook URL" value={url} onFocus={event => event.currentTarget.select()}/>
          <button type="button" className="btn" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
          <span className="sched-hook-note" role="status">{HOOK_ONCE}</span>
        </> : trigger ? <>
          <input className="iv-in sched-hook-url" readOnly aria-label="Webhook URL" value={maskedHookUrl(trigger.tokenHint)}/>
          {trigger.canEdit && onRotate ? <button type="button" className="btn" aria-disabled={busy || undefined} onClick={() => act(onRotate)}>Rotate URL</button> : null}
        </> : null}
      </> : draft.kind === 'interval'
        ? <select className="iv-in" aria-label="How often" value={draft.mins} disabled={!editable} onChange={event => set({mins: Number(event.target.value)})}>
          {[...new Set([...MINUTES, draft.mins])].sort((a, b) => a - b).map(m => <option key={m} value={m}>every {m} min</option>)}
        </select>
        : <input className="iv-in" type="time" aria-label="Time" value={draft.time} readOnly={!editable} onChange={event => set({time: event.target.value})}/>}
    </div>
    {/* No live region: the summary repeats the prompt, so it would be read again on every keystroke. */}
    <div className="lk-sum">
      {hook || appKind
        ? <><b>{agent || 'someone'}</b> will {willDo(prompt)} · <b>{text}</b>. Runs each time it happens. If a run can't start, it shows up in Needs you.</>
        : <><b>{agent || 'someone'}</b> will {willDo(prompt)} · <b>{text}</b>.{next !== null ? ` Next run: ${atText(next, tz)} (${relTime(next, at)}).` : ''} If a run can't start, it shows up in Needs you. Times are in {tz}.</>}
    </div>
    {problem ? <div className="calm sched-app-err" role="alert">{problem}</div> : null}
    <div className="iv-foot">
      {item && onDelete ? <button type="button" className="btn" style={{marginRight: 'auto'}} aria-disabled={busy || undefined} onClick={() => act(onDelete)}>Delete</button> : null}
      {item && onPause ? <button type="button" className="btn" aria-disabled={busy || undefined} onClick={() => act(() => onPause(!item.on))}>{item.on ? 'Pause' : 'Resume'}</button> : null}
      {editable ? <>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn pri" aria-disabled={!ready || busy || undefined} onClick={save}>{item ? 'Save' : 'Schedule it'}</button>
      </> : <button type="button" className="btn pri" onClick={onClose}>Done</button>}
    </div>
  </div>;
}
