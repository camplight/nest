import { z } from "zod";
export const AgentCharacterSchema = z.enum([
  "puff",
  "moss",
  "muff",
  "pom",
  "pip",
]);
export type AgentCharacter = z.infer<typeof AgentCharacterSchema>;
export const PersonalAgentSchema = z
  .object({
    name: z
      .string()
      .trim()
      .regex(
        /^[A-Za-z][A-Za-z0-9_-]{2,47}$/,
        "Use 3–48 letters, numbers, underscores or hyphens.",
      ),
    character: AgentCharacterSchema.default("puff"),
    brief: z.string().trim().max(2000).default(""),
  })
  .strict();
export type PersonalAgentInput = z.infer<typeof PersonalAgentSchema>;
export type PersonalAgentSetup = {
  id: string;
  name: string;
  character: AgentCharacter;
  brief: string;
  agentId: string | null;
  channelId: string | null;
  completedAt: number | null;
};
export type OnboardingState = {
  setup: PersonalAgentSetup | null;
  provisioningAvailable: boolean;
  connectionsAvailable: boolean;
  suggestedName: string;
  runtimeState: string | null;
  problem: string | null;
};

/** Product setup mapping only; no runtime or provider health checks. */
export type OnboardingSummary = Pick<OnboardingState, "setup">;
