import { createHash } from "node:crypto";
import { HTTPException } from "hono/http-exception";
import type { ProductDb } from "@nest/db";
import type { OrgOpsClient } from "@nest/orgops-client";

type Channel = Awaited<ReturnType<OrgOpsClient["connectionContext"]>>["channels"][number];
type Project = { id: string; name: string; channel_id: string; owner_id: string };

export function createConnectionProjectAccess(store: ProductDb) {
  function project(channelId: string, ownerId: string) {
    return store.db.prepare("SELECT id,name,channel_id,owner_id FROM product_projects WHERE channel_id=? AND owner_id=? AND collaboration='team'")
      .get(channelId, ownerId) as Project | undefined;
  }
  function audience(channel: Channel, ownerId: string): string | null {
    if (channel.visibility !== "PRIVATE" || channel.ownerHumanId !== ownerId ||
        channel.archivedAt || !Array.isArray(channel.shares) || channel.shares.length ||
        !Array.isArray(channel.participants) || !channel.participants.length ||
        channel.participants.some(p => !["HUMAN", "AGENT"].includes(p.subscriberType))) return null;
    const participants = channel.participants.map(p => [p.subscriberType, p.subscriberId]).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return createHash("sha256").update(JSON.stringify({channelId:channel.id, ownerId, participants})).digest("hex");
  }
  function approved(channel: Channel, agentId: string, ownerId: string) {
    const p = project(channel.id, ownerId), snapshot = audience(channel, ownerId);
    if (!p || !snapshot) return false;
    return Boolean(store.db.prepare("SELECT 1 FROM product_connection_projects WHERE agent_id=? AND owner_id=? AND project_id=? AND audience_hash=?")
      .get(agentId, ownerId, p.id, snapshot));
  }
  function review(channel: Channel, agentId: string, ownerId: string) {
    const p = project(channel.id, ownerId);
    if (!p) return null;
    return {projectId:p.id, name:p.name, participants:channel.participants,
      audienceHash:audience(channel, ownerId), approved:approved(channel, agentId, ownerId)};
  }
  function approve(channel: Channel, agentId: string, ownerId: string, expectedHash: string) {
    const p = project(channel.id, ownerId), snapshot = audience(channel, ownerId);
    if (!p || !snapshot || snapshot !== expectedHash)
      throw new HTTPException(409, {message:"Project audience changed or is shared. Reload and review its participants."});
    store.db.prepare("INSERT INTO product_connection_projects VALUES(?,?,?,?,?) ON CONFLICT(agent_id,owner_id,project_id) DO UPDATE SET audience_hash=excluded.audience_hash,approved_at=excluded.approved_at")
      .run(agentId, ownerId, p.id, snapshot, Date.now());
    return p;
  }
  const isProject = (channelId: string) => Boolean(store.db.prepare("SELECT 1 FROM product_projects WHERE channel_id=?").get(channelId));
  return {approved, review, approve, isProject};
}
