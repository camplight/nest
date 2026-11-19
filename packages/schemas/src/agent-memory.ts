/** The engine's conversation memory modes. */
export const ENGINE_MEMORY_MODES = ['PER_CHANNEL_CROSS_CHANNEL', 'FULL_CHANNEL_EVENTS', 'OFF'] as const;
/**
 * Nest's "Full history, summarized when long": stored in the engine as
 * FULL_CHANNEL_EVENTS while Nest compacts the agent's long chats.
 */
export const AUTO_COMPACT_MEMORY_MODE = 'FULL_CHANNEL_EVENTS_AUTO_COMPACT' as const;
export type AgentMemoryMode = typeof ENGINE_MEMORY_MODES[number] | typeof AUTO_COMPACT_MEMORY_MODE;
