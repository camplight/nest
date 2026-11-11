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
