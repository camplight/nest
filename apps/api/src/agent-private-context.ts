import { HTTPException } from "hono/http-exception";
import type { OrgOpsClient } from "@nest/orgops-client";

/** Shared privacy boundary for connected accounts and approved assistant work. */
export function createPrivateAgentContext({
  orgops,
  engineToken,
  onSecured,
  trustedCollaboration = false,
}: {
  orgops: OrgOpsClient;
  engineToken?: string;
  /** Connected apps trust direct participants while their owner is present. */
  trustedCollaboration?: boolean;
  onSecured?: (
    ownerId: string,
    details: { agentId: string; channelId: string },
  ) => void;
}) {
  const fail = (status: 403 | 503, message: string): never => {
    throw new HTTPException(status, { message });
  };
  async function privateContext(
    agentName: string,
    ownerId: string,
    agentId?: string,
    channelId?: string,
    activateHeaders?: Headers,
  ): Promise<{
    agent: {
      id: string;
      name: string;
      ownerHumanId: string;
      visibility: string;
    };
    channelId: string;
  }> {
    if (!engineToken)
      fail(503, "Private agent access requires engine metadata configuration");
    const { agent, channels, humans } = await orgops.connectionContext(
      agentName,
      engineToken!,
    );
    if (
      agent.ownerHumanId !== ownerId ||
      agent.visibility !== "PRIVATE" ||
      (agentId && agent.id !== agentId) ||
      agent.mode === "WRAPPED"
    )
      fail(403, "Agent ownership changed");
    const owner =
      humans.find((h) => h.id === ownerId) ??
      fail(403, "Agent owner is unavailable");
    const subscribed = channels.filter((ch) =>
      ch.participants?.some(
        (p) => p.subscriberType === "AGENT" && p.subscriberId === agent.name,
      ),
    );
    // The runner creates this GROUP for startup/schedule events. Its name is
    // not an authorization boundary: require the canonical shape AND privacy.
    const lifecycle = subscribed.filter(
      (ch) =>
        ch.name === `agent.lifecycle.${agent.name}` &&
        ch.description === `Lifecycle bootstrap channel for ${agent.name}` &&
        ch.kind === "GROUP",
    );
    const conversations = subscribed.filter((ch) => !lifecycle.includes(ch));
    const ch = (channelId
      ? conversations.find((entry) => entry.id === channelId)
      : conversations[0]) ?? fail(403, "The credential requires an active conversation.");
    if (
      !ch ||
      (!trustedCollaboration && conversations.length !== 1) ||
      conversations.some((entry) =>
        entry.archivedAt ||
        (!trustedCollaboration && (entry.ownerHumanId !== ownerId || entry.visibility !== "PRIVATE")) ||
        !["PRIVATE", "PUBLIC"].includes(entry.visibility) ||
        !Array.isArray(entry.shares) ||
        entry.shares.length > 0 ||
        !entry.participants.some((p) =>
          p.subscriberType === "HUMAN" && p.subscriberId === owner.username) ||
        entry.participants.some((p) => trustedCollaboration
          ? !["HUMAN", "AGENT"].includes(p.subscriberType)
          : !(
          (p.subscriberType === "HUMAN" && p.subscriberId === owner.username) ||
          (p.subscriberType === "AGENT" && p.subscriberId === agent.name)
        ))
      )
    )
      fail(
        403,
        trustedCollaboration
          ? "Connected apps require the owner to be a direct participant in every active conversation. Remove archived subscriptions or shared viewers, or rejoin the owner before retrying."
          : "This agent needs one unshared owner-only conversation. Remove other subscriptions or sharing before retrying.",
      );
    if (
      lifecycle.length > 1 ||
      lifecycle.some(
        (entry) =>
          entry.archivedAt ||
          !Array.isArray(entry.shares) ||
          entry.shares.length > 0 ||
          entry.participants.some(
            (p) =>
              !(
                (p.subscriberType === "AGENT" &&
                  p.subscriberId === agent.name) ||
                (p.subscriberType === "HUMAN" &&
                  p.subscriberId === owner.username)
              ),
          ) ||
          ((entry.visibility !== "PRIVATE" || entry.ownerHumanId !== ownerId) &&
            !(
              activateHeaders &&
              entry.visibility === "PUBLIC" &&
              !entry.ownerHumanId
            )),
      )
    )
      fail(
        403,
        "The agent's lifecycle channel must be private, owned by you and unshared. Renew skill access to secure its default lifecycle channel.",
      );
    const unsecured = lifecycle.find((entry) => entry.visibility === "PUBLIC");
    if (unsecured) {
      const response = await orgops.humanRequest(
        `/api/channels/${encodeURIComponent(unsecured.id)}`,
        activateHeaders!,
        "PATCH",
        { visibility: "PRIVATE" },
      );
      if (!response.ok)
        fail(
          403,
          "Could not secure the agent's lifecycle channel. Ask your administrator to check channel permissions.",
        );
      onSecured?.(ownerId, { agentId: agent.id, channelId: unsecured.id });
      // Re-read after mutation before issuing any credential. Execution never repairs.
      return privateContext(agentName, ownerId, agentId, ch.id);
    }
    return { agent, channelId: ch.id };
  }
  return privateContext;
}
