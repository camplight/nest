// The open chat's "Where it stands" (the mock's `.digest`): shown only while something in this chat waits on the person
// (a hand-off awaiting their OK, a task awaiting their review, or a missed run). Its first line is the chat's first agent
// row; there are no generated digests. Approve / Request changes appear when the reason starts with Approve or Review, as
// the mock's regex has it; a missed run gets Run now.
import {useState} from 'react';
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
  return <button type="button" className={className} disabled={busy} aria-label={named ? `Run now: ${item.chatTitle}` : undefined}
    onClick={() => { setBusy(true); void onRunNow(item).finally(() => setBusy(false)); }}>Run now</button>;
}

export function ChatDigest({items, agentLine, onApprove, onRequestChanges, onRunNow, canDecide}: ChatDigestProps) {
  const item = digestItem(items);
  const [busy, setBusy] = useState<string | null>(null);
  if (!item) return null;
  const approve = () => { setBusy(item.key); void onApprove(item).finally(() => setBusy(null)); };
  return <div className="digest" role="region" aria-label="Where it stands">
    <b>Where it stands</b>{agentLine}
    <div className="wy">Waiting on you: {item.short}</div>
    {canDecide && !canDecide(item) ? null : hasGate(item) ? <div className="gate">
      <button type="button" className="btn pri" disabled={busy === item.key} onClick={approve}>Approve</button>
      <button type="button" className="btn" disabled={busy === item.key} onClick={() => onRequestChanges(item)}>Request changes</button>
    </div> : item.gate?.kind === 'missed' ? <div className="gate"><RunNowButton key={item.key} item={item} onRunNow={onRunNow}/></div> : null}
  </div>;
}
