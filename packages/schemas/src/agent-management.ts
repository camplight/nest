import {z} from 'zod';
export const ManagedAgentInput = z.object({
  name:z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9 _-]*$/),
  description:z.string().trim().min(10).max(1000),
  systemInstructions:z.string().trim().min(40).max(16000),
}).strict();
export type ManagedAgentInput = z.infer<typeof ManagedAgentInput>;
