// Which chat's member list a live event may have changed. The engine posts no event when someone joins or leaves,
// so Nest notices an agent's add/remove tool result, or a message from someone the chat does not list yet.
import type {Channel,EventRow} from '../types';

const ROSTER_TOOLS=new Set(['events_channel_participant_add','events_channel_participant_remove']);
const record=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'?value as Record<string,unknown>:{};

/** The id of the chat whose members should be reloaded, or null when the event changes nobody's membership. */
export function rosterChange(event:EventRow,channels:readonly Channel[]):string|null{
 const payload=record(event.payload);
 if(event.type==='tool.executed'&&typeof payload.tool==='string'&&ROSTER_TOOLS.has(payload.tool)){
  const target=record(payload.args).channelId;
  return typeof target==='string'&&target?target:event.channelId??null;
 }
 if(event.type!=='message.created'||!event.channelId)return null;
 const channel=channels.find(item=>item.id===event.channelId);
 const [kind,...rest]=event.source.split(':'),name=rest.join(':');
 const type=kind==='agent'?'AGENT':kind==='human'?'HUMAN':null;
 if(!channel||!type||!name)return null;
 return channel.participants?.some(member=>member.subscriberType===type&&member.subscriberId===name)?null:channel.id;
}
