import {createHash} from 'node:crypto';
import {HTTPException} from 'hono/http-exception';
import type {ProductDb} from '@nest/db';
import type {OrgOpsClient} from '@nest/orgops-client';
type Channel=Awaited<ReturnType<OrgOpsClient['connectionContext']>>['channels'][number];

export function createConnectionChannelAccess(store:ProductDb) {
  function audience(ch:Channel, ownerId:string, username:string) {
    if(ch.visibility!=='PUBLIC'||ch.archivedAt||!Array.isArray(ch.shares)||ch.shares.length||
      !ch.participants.some(p=>p.subscriberType==='HUMAN'&&p.subscriberId===username)||
      ch.participants.some(p=>!['HUMAN','AGENT'].includes(p.subscriberType))) return null;
    const participants=ch.participants.map(p=>[p.subscriberType,p.subscriberId]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return createHash('sha256').update(JSON.stringify({channelId:ch.id,ownerId,visibility:ch.visibility,participants})).digest('hex');
  }
  function approved(ch:Channel, agentId:string, ownerId:string, username:string) {
    const snapshot=audience(ch,ownerId,username);
    return !!snapshot&&!!store.db.prepare('SELECT 1 FROM product_connection_channels WHERE agent_id=? AND owner_id=? AND channel_id=? AND audience_hash=?').get(agentId,ownerId,ch.id,snapshot);
  }
  function review(ch:Channel, agentId:string, ownerId:string, username:string) {
    return {channelId:ch.id,name:ch.name,participants:ch.participants,audienceHash:audience(ch,ownerId,username),approved:approved(ch,agentId,ownerId,username)};
  }
  function approve(ch:Channel, agentId:string, ownerId:string, username:string, expectedHash:string) {
    const snapshot=audience(ch,ownerId,username);
    if(!snapshot||snapshot!==expectedHash)throw new HTTPException(409,{message:'Channel membership changed. The owner must remain a participant; reload and review before approving.'});
    store.db.prepare('INSERT INTO product_connection_channels VALUES(?,?,?,?,?) ON CONFLICT(agent_id,owner_id,channel_id) DO UPDATE SET audience_hash=excluded.audience_hash,approved_at=excluded.approved_at').run(agentId,ownerId,ch.id,snapshot,Date.now());
  }
  return {approved,review,approve};
}
