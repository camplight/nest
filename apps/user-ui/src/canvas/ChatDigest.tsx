// The open chat's "Where it stands" (the mock's `.digest`): shown only while something in this chat waits on the person
// (a hand-off awaiting their OK, a task awaiting their review, or a missed run). Its first line is the chat's first agent
// row; there are no generated digests. Approve / Request changes appear when the reason starts with Approve or Review, as
// the mock's regex has it; a missed run gets Run now.
import {useLayoutEffect,useRef,useState} from 'react';
import type {NeedsItem} from './needs';

/** The kinds the digest shows: the person can settle them here. Mentions are answered in the chat; a paused link from its chip. */
const DIGEST_KINDS = new Set<NeedsItem['kind']>(['approval', 'review', 'missed']);
/** The mock's `/^(Approve|Review)/` on the reason. */
export const hasGate = (item: NeedsItem) => /^(Approve|Review)/.test(item.short);

/** The newest item this chat's digest is about, or null when nothing here waits on the person. `items` are newest first. */
export function digestItem(items: readonly NeedsItem[]): NeedsItem | null {
  return items.find(item => item.gate && DIGEST_KINDS.has(item.kind)) ?? null;
}

/** `{agent}: {activity}.` from a card's first agent row; null when the chat has no agent. */
export function agentLine(row: {label: string; text: string} | undefined): string | null {
  if (!row) return null;
  const text = row.text.trim().replace(/[.\s]+$/, '');
  return text ? `${row.label}: ${text}.` : null;
}

export type ChatDigestProps = {
  /** This chat's Needs you items, newest first. */
  items: readonly NeedsItem[];
  agentLine: string | null;
  onApprove(item: NeedsItem): Promise<void>;
  onRequestChanges(item: NeedsItem): void;
  /** A missed run's Run now. */
  onRunNow(item: NeedsItem): Promise<void>;
  /**
   * Whether the server lets this person decide the item (a review is the project owner's). Without it the digest still
   * says what waits, with no buttons. Default: yes.
   */
  canDecide?(item: NeedsItem): boolean;
};

/**
 * A missed run's `Run now`: busy until its request settles. Used by the digest and both Needs you lists, where `named`
 * adds the chat's title to its accessible name (a list has one per row).
 */
export function RunNowButton({item, onRunNow, className = 'btn', named = false}: {item: NeedsItem; onRunNow(item: NeedsItem): Promise<void>; className?: string; named?: boolean}) {
  const [busy, setBusy] = useState(false);
  // aria-disabled, not disabled: a disabled button drops focus to the page body.
  return <button type="button" className={className} aria-disabled={busy || undefined} aria-label={named ? `Run now: ${item.chatTitle}` : undefined}
    onClick={() => { if (busy) return; setBusy(true); void onRunNow(item).finally(() => setBusy(false)); }}>Run now</button>;
}

export function ChatDigest(props: ChatDigestProps) {
  const item = digestItem(props.items);
  return item ? <Digest {...props} item={item}/> : null;
}

/**
 * Where focus goes when the digest goes while it held focus (an Approve that settled the item): the chat's reply box when
 * it can be typed in, else the chat itself, never the page body.
 */
function refocus(chat: HTMLElement | null) {
  requestAnimationFrame(() => {
    const now = document.activeElement;
    if (now && now !== document.body && now.isConnected) return;
    const box = chat?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]:not(:disabled)');
    (box ?? chat)?.focus({preventScroll: true});
  });
}

function Digest({item, agentLine, onApprove, onRequestChanges, onRunNow, canDecide}: ChatDigestProps & {item: NeedsItem}) {
  const root = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Runs before the digest leaves the page, while it still holds focus.
  useLayoutEffect(() => () => {
    const node = root.current;
    if (node?.contains(document.activeElement)) refocus(node.closest<HTMLElement>('.canvas-chat'));
  }, []);
  // aria-disabled, not disabled: a disabled button drops focus to the page body.
  const waiting = busy === item.key;
  const approve = () => { if (waiting) return; setBusy(item.key); void onApprove(item).finally(() => setBusy(null)); };
  return <div ref={root} className="digest" role="region" aria-label="Where it stands">
    <b>Where it stands</b>{agentLine}
    <div className="wy">Waiting on you: {item.short}</div>
    {canDecide && !canDecide(item) ? null : hasGate(item) ? <div className="gate">
      <button type="button" className="btn pri" aria-disabled={waiting || undefined} onClick={approve}>Approve</button>
      <button type="button" className="btn" aria-disabled={waiting || undefined} onClick={() => { if (!waiting) onRequestChanges(item); }}>Request changes</button>
    </div> : item.gate?.kind === 'missed' ? <div className="gate"><RunNowButton key={item.key} item={item} onRunNow={onRunNow}/></div> : null}
  </div>;
}
