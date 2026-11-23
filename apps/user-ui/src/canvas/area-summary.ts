// An area's compact-zoom summary line (the mock's `area-sum`). Pure; no DOM.
import type {AreaSummary} from './Area';

export type SummaryPart = {text: string; need?: true};

/**
 * `2 need you · 3 moving · 1 quiet`, leaving out the parts that are zero; `all quiet` when every part is zero, and
 * `Shared resources` for an area that holds no chats while other areas use its context.
 */
export function summaryParts(summary: AreaSummary, usedByOthers: boolean): SummaryPart[] {
  if (!summary.chats && usedByOthers) return [{text: 'Shared resources'}];
  const parts: SummaryPart[] = [];
  if (summary.needYou) parts.push({text: `${summary.needYou} need you`, need: true});
  if (summary.moving) parts.push({text: `${summary.moving} moving`});
  if (summary.quiet) parts.push({text: `${summary.quiet} quiet`});
  return parts.length ? parts : [{text: 'all quiet'}];
}

/** The top bar's `5 chats · 2 moving · 1 quiet`: quiet is left out at zero, a single chat reads `1 chat`. */
export function summaryText(summary: {chats: number; moving: number; quiet: number}): string {
  const parts = [`${summary.chats} ${summary.chats === 1 ? 'chat' : 'chats'}`, `${summary.moving} moving`];
  if (summary.quiet) parts.push(`${summary.quiet} quiet`);
  return parts.join(' · ');
}
