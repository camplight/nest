// Flows on the client: whether hand-offs are set up here, the Switchyard service agent's name, the viewer's flow
// Needs you items and schedules (each polled every 15 s while the page is visible, and on focus; never with the flag off
// or flows unavailable) and a reader for one chat's links.
import {useCallback,useEffect,useRef,useState,useSyncExternalStore} from 'react';
import type {FlowNeed} from '@nest/schemas';
import {getAvailability,getLinks,getNeeds,getSchedules,type FlowsAvailability,type LinkView,type ScheduleList} from './flows-api';

export const FLOW_NEEDS_MS = 15_000;
const NO_NEEDS: FlowNeed[] = [];
const NO_SCHEDULES: ScheduleList = {schedules: [], agentMade: [], triggers: []};

// One availability read per page: App (for the chat views) and the canvas share it. A failed read, or an answer that
// flows are unavailable (an engine outage), is read again the next time a view asks.
let availability: FlowsAvailability | null = null;
let reading: Promise<FlowsAvailability | null> | null = null;
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** Reads availability once; later calls share the answer. Null when the read fails (the flag off answers 404). */
export function loadAvailability(): Promise<FlowsAvailability | null> {
  if (availability?.enabled) return Promise.resolve(availability);
  reading ??= getAvailability()
    .then(result => { availability = result; notify(); return result; })
    .catch(() => null)
    .finally(() => { reading = null; });
  return reading;
}

/**
 * The service agent's engine name (`Switchyard` by default), once flows are set up; null before the read, with the
 * flag off, or when the name belongs to someone else's agent (that agent is a real one and stays listed).
 */
export function useServiceAgent(load = false): string | null {
  useEffect(() => { if (load) void loadAvailability(); }, [load]);
  return useSyncExternalStore(subscribe, () => availability?.serviceAgent ?? null, () => null);
}
/** Whether flows (hand-offs, forks) are set up here; false before the read and with the flag off. */
export function useFlowsEnabled(load = false): boolean {
  useEffect(() => { if (load) void loadAvailability(); }, [load]);
  return useSyncExternalStore(subscribe, () => availability?.enabled === true, () => false);
}
/** Whether this engine name is the service agent: never a card row, tray or picker face, mention or quiet agent. */
export const isServiceAgent = (name: string, service: string | null) => service !== null && name === service;

export type Flows = {
  availability: FlowsAvailability | null;
  /** The viewer's approvals and paused links, newest first. */
  needs: FlowNeed[];
  /** Every schedule in a chat the viewer can read, and agents' own booked runs; empty until read. */
  schedules: ScheduleList;
  /** Every link touching a chat the viewer can read, with titles, version and rights. */
  links(channelId: string): Promise<LinkView[]>;
  /** Re-reads the needs and schedules now (after an approve, pause, disconnect, Run now or a schedule change). */
  refresh(): void;
};

export function useFlows(enabled: boolean): Flows {
  const current = useSyncExternalStore(subscribe, () => availability, () => null);
  useEffect(() => { if (enabled) void loadAvailability(); }, [enabled]);
  const on = enabled && Boolean(current?.enabled);
  const [needs, setNeeds] = useState<FlowNeed[]>(NO_NEEDS);
  const [schedules, setSchedules] = useState<ScheduleList>(NO_SCHEDULES);
  const reload = useRef<() => void>(() => {});
  useEffect(() => {
    if (!on) { setNeeds(NO_NEEDS); setSchedules(NO_SCHEDULES); return; }
    let live = true;
    const load = () => {
      getNeeds().then(items => { if (live) setNeeds(items); }).catch(() => {});
      getSchedules().then(list => ({...list, triggers: list.triggers ?? []})).then(list => { if (live) setSchedules(current => JSON.stringify(current) === JSON.stringify(list) ? current : list); }).catch(() => {});
    };
    const tick = () => { if (document.visibilityState !== 'hidden') load(); };
    load();
    reload.current = load;
    const timer = setInterval(tick, FLOW_NEEDS_MS);
    window.addEventListener('focus', load);
    return () => { live = false; reload.current = () => {}; clearInterval(timer); window.removeEventListener('focus', load); };
  }, [on]);
  const links = useCallback((channelId: string) => getLinks(channelId), []);
  const refresh = useCallback(() => reload.current(), []);
  return {availability: enabled ? current : null, needs, schedules, links, refresh};
}
