// The open chat's collapsed Setup line (the mock's cfgBlock): a summary of its agents and how many chats it is connected
// to, opening onto the schedule strips (Task 11) and the links row (the mock's linksRow): `Gets from ← A`, `Passes to → B`
// chips that open the Hand-off popover, and `+ Connect`. Loose chats have no links row. Whether it is open is remembered
// per person in this browser.
import {Fragment,useState,type ReactNode} from 'react';
import {AgentAvatar} from '../components/AgentAvatar';
import type {LinkView} from './flows-api';
import {LinkIcon} from './Links';

export type ChatSetupProps = {
  channelId: string;
  /** A chat that is not on this canvas: no links row. */
  loose: boolean;
  /** Every link touching this chat that the viewer can read (forks are counted and listed elsewhere). */
  links: readonly LinkView[];
  /** The schedule strips, first in the body (Task 11). */
  schedules?: ReactNode;
  /** The chat's agents, without the service agent. */
  agents: readonly string[];
  /** The signed-in person: the open state is theirs. */
  viewer: string;
  /** `+ Connect`: the chat picker for this chat, under the pressed button. */
  onConnect(anchor: HTMLElement): void;
  /** A chip: that link's Hand-off popover, under the chip. */
  onOpenLink(link: LinkView, anchor: HTMLElement): void;
};

const openKey = (viewer: string) => `nest-canvas-setup-open:${viewer}`;
function readOpen(viewer: string) {
  try { return localStorage.getItem(openKey(viewer)) === '1'; } catch { return false; }
}
function writeOpen(viewer: string, open: boolean) {
  try { localStorage.setItem(openKey(viewer), open ? '1' : '0'); } catch {}
}

/** The summary's `{n} connected`: hand-off links into or out of this chat; fork lines are not counted. */
export const connectedCount = (channelId: string, links: readonly LinkView[]) =>
  links.filter(l => l.kind === 'link' && (l.from === channelId || l.to === channelId)).length;

export function ChatSetup({channelId, loose, links, schedules, agents, viewer, onConnect, onOpenLink}: ChatSetupProps) {
  const [open, setOpen] = useState(() => readOpen(viewer));
  const ins = links.filter(l => l.kind === 'link' && l.to === channelId), outs = links.filter(l => l.kind === 'link' && l.from === channelId);
  const connected = ins.length + outs.length;
  const bits: {key: string; node: ReactNode}[] = [
    ...agents.map(name => ({key: `a:${name}`, node: <span className="sm-chip"><AgentAvatar name={name} size={18}/>{name}</span>})),
    ...(connected ? [{key: 'links', node: <span className="sm-chip"><LinkIcon/>{connected} connected</span>}] : []),
  ];
  const chip = (link: LinkView, dir: 'in' | 'out') => {
    const other = dir === 'in' ? link.fromTitle : link.toTitle;
    return <button key={link.id} type="button" className={`lnk${link.on ? '' : ' off'}`} aria-haspopup="dialog"
      title={`${dir === 'in' ? 'Gets results from' : 'Passes results to'} ${other}`} onClick={event => onOpenLink(link, event.currentTarget)}>
      {dir === 'in' ? '← ' : '→ '}{other}
    </button>;
  };
  return <details className="cfg" open={open} onToggle={event => {
    const next = event.currentTarget.open;
    if (next === open) return;
    setOpen(next);
    writeOpen(viewer, next);
  }}>
    <summary>
      {bits.map((bit, n) => <Fragment key={bit.key}>{n ? <span className="dotsep" aria-hidden="true">·</span> : null}{bit.node}</Fragment>)}
      <span className="more">Setup</span>
    </summary>
    <div className="cfg-body">
      {schedules}
      {loose ? null : <div className="links-row">
        {ins.length ? <><span>Gets from</span>{ins.map(link => chip(link, 'in'))}</> : null}
        {outs.length ? <><span>Passes to</span>{outs.map(link => chip(link, 'out'))}</> : null}
        <button type="button" className="add" aria-haspopup="dialog" onClick={event => onConnect(event.currentTarget)}>+ Connect</button>
      </div>}
    </div>
  </details>;
}
