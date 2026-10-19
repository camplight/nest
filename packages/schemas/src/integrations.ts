import { z } from "zod";

// Exact grants remain bounded, but full app catalogs routinely exceed 100 actions.
export const MAX_CONNECTION_ACTIONS = 2_000;
export const MAX_CONNECTION_GRANT_BYTES = 512_000;
export const MAX_CONNECTION_CATALOG_PAGES = 100;
export const integrationToolName = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
export const connectionLinkInput = z
  .object({ toolkit: integrationToolName })
  .strict();
export const connectionGrantInput = z
  .object({ tools: z.array(integrationToolName).max(MAX_CONNECTION_ACTIONS) })
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
export type ConnectionProjectReview = {
  projectId: string;
  name: string;
  participants: { subscriberType: string; subscriberId: string }[];
  audienceHash: string | null;
  approved: boolean;
};
