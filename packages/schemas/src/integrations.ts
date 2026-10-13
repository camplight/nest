import { z } from "zod";
export const integrationToolName = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
export const connectionLinkInput = z
  .object({ toolkit: integrationToolName })
  .strict();
export const connectionGrantInput = z
  .object({ tools: z.array(integrationToolName).max(100) })
  .strict();
export const connectionToolInput = z
  .object({
    connectionId: z.string().min(1).max(200),
    tool: integrationToolName,
  })
  .strict();
export const connectionExecuteInput = connectionToolInput
  .extend({ arguments: z.record(z.unknown()) })
  .strict();
export type ConnectionCapability = {
  configured: boolean;
  skillAvailable: boolean;
};
export type ConnectionSkillStatus = {
  enabled: boolean;
  expiresAt: number | null;
  /** Saved permissions on locally nonrevoked accounts; not provider availability. */
  grantedToolCount: number;
  /** Whether the enabled skill is configured for preloading on the next turn. */
  preloadConfigured: boolean;
};
