// The floating label that follows an agent dragged over a card or empty canvas, and the dragged name it needs: a drag's
// data is unreadable until the drop, so the tray records the name here when the drag starts.
export const CANT_INVITE = "You can't add agents to this chat";

export type InviteTarget = {title: string; access: string; manageable: boolean; members: string[]};

export function inviteLabel({agent, card}: {agent: string; card: InviteTarget}): string {
  if (card.access !== 'open' || !card.manageable) return CANT_INVITE;
  if (card.members.includes(agent)) return `${agent} is already here`;
  return `Invite ${agent} to "${card.title}"`;
}

/** Over empty canvas (editors): dropping starts a chat with the agent, in the area under the pointer if any. */
export function startLabel(agent: string, areaTitle?: string): string {
  const area = areaTitle?.trim();
  return area ? `Start a chat with ${agent} in ${area}` : `Start a chat with ${agent}`;
}

let dragged: string | null = null;
export const setDraggedAgent = (name: string | null) => { dragged = name; };
export const draggedAgent = () => dragged;
