import type {Channel} from './types';

/** Only true one-to-one private chats belong under an agent, never projects or shared rooms. */
export function conversationAgent(channel: Channel, username: string, userId: string | null): string | null {
  if (channel.visibility !== 'PRIVATE' || channel.shares?.length) return null;
  const members = channel.participants ?? [];
  const humans = members.filter(m => m.subscriberType.toUpperCase() === 'HUMAN');
  const agents = members.filter(m => m.subscriberType.toUpperCase() === 'AGENT');
  if (members.length !== 2 || humans.length !== 1 || agents.length !== 1) return null;
  return [username, userId].includes(humans[0].subscriberId) ? agents[0].subscriberId : null;
}

export function recentAgentChat(userId: string | null, name: string): string | null {
  try { return localStorage.getItem(`nest.agent-chat.${userId}.${name}`); } catch { return null; }
}
export function rememberAgentChat(userId: string | null, name: string, id: string) {
  try { localStorage.setItem(`nest.agent-chat.${userId}.${name}`, id); } catch { /* Navigation works without storage. */ }
}
