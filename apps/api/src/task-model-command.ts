import { TaskModelSchema } from '@orgops/schemas';

/** Opt-in first line. Keep original text/mention offsets unchanged for receipts and display. */
export function taskModelCommand(text: string, agentName?: string) {
  const first = text.split(/\r?\n/, 1)[0].trim();
  if (!/^\/model(?:\s|$)/.test(first)) return undefined;
  if (!agentName) throw Error('Choose one agent for a /model task. Select its @mention, or use its private chat.');
  if (!text.slice(text.indexOf('\n') + 1).trim() || !text.includes('\n'))
    throw Error('Put the task on the next line after /model.');
  const parts = first.split(/\s+/).slice(1);
  const value = parts[0] === 'auto' && parts.length === 3
    ? {agentName,mode:'economy',minIntelligence:Number(parts[1]),maxPricePerMillion:Number(parts[2]),minContextTokens:32000}
    : parts.length === 1 ? {agentName,mode:'manual',modelId:parts[0]} : null;
  const parsed = TaskModelSchema.safeParse(value);
  if (!parsed.success) throw Error('Use /model openrouter:vendor/model or /model auto MIN_SCORE MAX_USD_PER_MILLION, then a new line and your task.');
  return parsed.data;
}
