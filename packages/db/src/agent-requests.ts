import type Database from "better-sqlite3";
import type { AgentRequestStatus } from "@nest/schemas";

export type OfferRow = {
  agent_id: string;
  agent_name: string;
  owner_id: string;
  enabled: number;
  description: string;
  created_at: number;
  updated_at: number;
};
export type AgentRequestRow = {
  id: string;
  agent_id: string;
  agent_name: string;
  owner_id: string;
  requester_id: string;
  title: string;
  brief: string;
  status: AgentRequestStatus;
  version: number;
  channel_id: string | null;
  event_id: string | null;
  dispatched_at: number | null;
  response_event_id: string | null;
  reply: string;
  feedback: string;
  created_at: number;
  updated_at: number;
};
export function createAgentRequestStore(db: Database.Database) {
  const request = (id: string) =>
    db.prepare("SELECT * FROM product_agent_requests WHERE id=?").get(id) as
      AgentRequestRow | undefined;
  const offer = (name: string) =>
    db
      .prepare("SELECT * FROM product_agent_offers WHERE agent_name=?")
      .get(name) as OfferRow | undefined;
  function audit(type: string, actor: string, details: unknown) {
    db.prepare(
      "INSERT INTO product_audit(type,actor_id,payload_json,created_at) VALUES(?,?,?,?)",
    ).run(type, actor, JSON.stringify(details), Date.now());
  }
  function change(
    row: AgentRequestRow,
    patch: Partial<AgentRequestRow>,
    actor: string,
  ) {
    const next = {
      ...row,
      ...patch,
      version: row.version + 1,
      updated_at: Date.now(),
    };
    return db.transaction(() => {
      const changed = db
        .prepare(
          `UPDATE product_agent_requests SET status=@status,version=@version,channel_id=@channel_id,event_id=@event_id,dispatched_at=@dispatched_at,response_event_id=@response_event_id,reply=@reply,feedback=@feedback,updated_at=@updated_at WHERE id=@id AND version=@previous`,
        )
        .run({ ...next, previous: row.version }).changes;
      if (!changed) return null;
      audit("audit.assistant.request.changed", actor, {
        requestId: row.id,
        status: next.status,
        version: next.version,
      });
      return next;
    })();
  }
  return {
    request,
    offer,
    change,
    audit,
    offers: () =>
      db
        .prepare(
          "SELECT * FROM product_agent_offers WHERE enabled=1 ORDER BY agent_name",
        )
        .all() as OfferRow[],
    list: (
      actor: string,
      offset: number,
      limit: number,
      direction: "all" | "incoming" | "outgoing" = "all",
    ) => {
      const clause =
        direction === "all"
          ? "owner_id=? OR requester_id=?"
          : direction === "incoming"
            ? "owner_id=?"
            : "requester_id=?";
      const args =
        direction === "all"
          ? [actor, actor, limit, offset]
          : [actor, limit, offset];
      return db
        .prepare(
          `SELECT * FROM product_agent_requests WHERE ${clause} ORDER BY updated_at DESC,id DESC LIMIT ? OFFSET ?`,
        )
        .all(...args) as AgentRequestRow[];
    },
  };
}
