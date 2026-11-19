import { z } from "zod";
import type { EventShapeDefinition } from "@orgops/schemas";

/** One connected-app call (a change, a read or an untagged tool), posted by Nest into the agent's chat.
 * The telemetry prefix keeps it out of every agent's conversation history. */
export const eventShapes: EventShapeDefinition[] = [
  {
    type: "telemetry.nest.connection.action",
    description:
      "A connected-app action that created, updated or deleted something, recorded by Nest in the chat where the agent ran it. Nest posts it; agents never emit it.",
    source: "skill:nest-connections",
    eventSchema: z.object({
      source: z.literal("system:nest-connections"),
      channelId: z.string().min(1),
      payload: z
        .object({
          agentName: z.string().min(1),
          connectionId: z.string().min(1),
          app: z.string().min(1),
          tool: z.string().min(1),
          title: z.string().min(1),
          change: z.enum(["create", "update", "delete", "read", "other"]),
          outcome: z.enum(["ok", "failed", "unknown"]),
          requestId: z.string().min(1),
        })
        .strict(),
    }),
    payloadExample: {
      agentName: "NikiPA",
      connectionId: "connection-id",
      app: "miro",
      tool: "MIRO_CREATE_IMAGE_ITEM_FROM_URL",
      title: "Create image item from URL",
      change: "create",
      outcome: "ok",
      requestId: "request-id",
    },
  },
];
