import { friendlyActionName } from "@nest/schemas";
import type { OrgOpsClient } from "@nest/orgops-client";
import type { IntegrationTool } from "./provider";

export type ActionChange = "create" | "update" | "delete" | "read" | "other";
export type ActionOutcome = "ok" | "failed" | "unknown";
export type ActionLineInput = {
  channelId?: string;
  ownerId: string;
  agentId: string;
  agentName: string;
  connectionId: string;
  tool: IntegrationTool;
  outcome: ActionOutcome;
  requestId: string;
};

export const ACTION_LINE_TYPE = "telemetry.nest.connection.action";
export const ACTION_LINE_SOURCE = "system:nest-connections";

/** What a provider action does, from its hint tags. Only create/update/delete become lines under replies. */
export function actionChange(tags: readonly string[]): ActionChange {
  if (tags.includes("readOnlyHint")) return "read";
  if (tags.includes("destructiveHint")) return "delete";
  if (tags.includes("updateHint")) return "update";
  if (tags.includes("createHint")) return "create";
  return "other";
}

/** Records every connected-app call in the chat the agent ran it from (lines and the working ring). Never throws. */
export function createActionLines(deps: {
  orgops: OrgOpsClient;
  engineToken?: string;
  audit(type: string, ownerId: string, data: Record<string, unknown>): void;
  timeoutMs?: number;
}) {
  const timeoutMs = deps.timeoutMs ?? 2000;
  return {
    async record(input: ActionLineInput): Promise<void> {
      if (!input.channelId || !deps.engineToken) return;
      try {
        const change = actionChange(input.tool.tags ?? []);
        const engine = deps.orgops.connectionActivity(deps.engineToken);
        const signal = AbortSignal.timeout(timeoutMs);
        const channel = await engine.channel(input.channelId, signal);
        const reason = !channel
          ? "missing"
          : !channel.participants.some(
                (p) => p.subscriberType === "AGENT" && p.subscriberId === input.agentName,
              )
            ? "not_participant"
            : channel.archivedAt
              ? "archived"
              : null;
        if (reason) {
          deps.audit("audit.connection.tool.line_rejected", input.ownerId, {
            requestId: input.requestId,
            agentId: input.agentId,
            reason,
          });
          return;
        }
        await engine.post(
          {
            type: ACTION_LINE_TYPE,
            source: ACTION_LINE_SOURCE,
            channelId: input.channelId,
            status: "DELIVERED",
            idempotencyKey: `nest:connection-action:${input.requestId}`,
            payload: {
              agentName: input.agentName,
              connectionId: input.connectionId,
              app: input.tool.toolkit,
              tool: input.tool.slug,
              title: friendlyActionName(input.tool.name, input.tool.slug, input.tool.toolkit),
              change,
              outcome: input.outcome,
              requestId: input.requestId,
            },
          },
          signal,
        );
      } catch (error) {
        // Best effort: the agent's result never depends on the line. No payloads or tokens here.
        console.warn(
          "Connection activity line not recorded:",
          error instanceof Error ? error.name : "unknown error",
        );
      }
    },
  };
}
