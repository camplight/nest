import { z } from "zod";

export const AssistantOfferInput = z
  .object({
    enabled: z.boolean(),
    description: z.string().trim().max(1200),
  })
  .strict()
  .refine((value) => !value.enabled || value.description.length > 0, {
    message: "Describe what teammates may request",
  });
export const NewAgentRequestInput = z
  .object({
    id: z.string().uuid(),
    agentName: z.string().trim().min(1).max(120),
    title: z.string().trim().min(1).max(180),
    brief: z.string().trim().min(1).max(8000),
  })
  .strict();
export const AgentRequestActionInput = z
  .object({ version: z.number().int().nonnegative() })
  .strict();
export const AgentRequestDecisionInput = z
  .object({
    version: z.number().int().nonnegative(),
    feedback: z.string().trim().max(2000).default(""),
  })
  .strict();
export const AgentRequestReplyInput = z
  .object({
    version: z.number().int().nonnegative(),
    eventId: z.string().uuid(),
    reply: z.string().trim().min(1).max(24000),
  })
  .strict();
export type AssistantOffer = {
  agentName: string;
  ownerName: string;
  description: string;
  yours: boolean;
};
export type AgentRequestStatus =
  | "pending"
  | "dispatching"
  | "working"
  | "completed"
  | "declined"
  | "cancelled";
export type AgentRequest = {
  id: string;
  agentName: string;
  ownerName: string;
  requesterName: string;
  title: string;
  brief: string;
  status: AgentRequestStatus;
  version: number;
  isOwner: boolean;
  reply: string | null;
  feedback: string;
  createdAt: number;
  updatedAt: number;
};
export type AgentRequestList = { items: AgentRequest[]; hasMore: boolean };
export type AgentRequestResponse = {
  id: string;
  text: string;
  createdAt: number;
};
